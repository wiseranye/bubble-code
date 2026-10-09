import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  FunctionParameters,
} from 'openai/resources.js';
import type { AnyTool } from '../../tools/types.ts';
import {
  type AssistantMessage,
  AssistantMessageEventStream,
  type Message,
  type Model,
  type StopReason,
  type StreamOptions,
  type Text,
  type Thinking,
  type ToolCall,
} from '../types.ts';

// OpenAI 的工具调用分片只有 index 稳定，其余字段可能只在一部分分片里出现
type ToolCallDelta = {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

export class OpenAiModel implements Model {
  private readonly client: OpenAI;

  private readonly model: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey,
    });
    this.model = model;
  }

  stream(
    messages: Message[],
    options?: StreamOptions,
  ): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();

    (async () => {
      const output: AssistantMessage = {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
        timestamp: Date.now(),
      };
      try {
        await this.doStreaming(stream, messages, output, options);
      } catch (error: unknown) {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        const aborted =
          options?.signal?.aborted === true ||
          error instanceof OpenAI.APIUserAbortError ||
          normalizedError.name === 'AbortedError';
        output.stopReason = aborted ? 'aborted' : 'error';
        output.errorMessage = normalizedError.message;
        stream.push({
          type: 'error',
          reason: output.stopReason,
          error: normalizedError,
          message: output,
        });
        stream.end();
      }
    })();

    return stream;
  }

  private async doStreaming(
    stream: AssistantMessageEventStream,
    input: Message[],
    output: AssistantMessage,
    options?: StreamOptions,
  ): Promise<void> {
    // Build tools
    const tools: OpenAI.ChatCompletionTool[] = (options?.tools ?? []).map(
      tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: this.makeJsonSchemaToolParameters(tool),
        },
      }),
    );
    // Build messages
    const msgs = input.map((message): OpenAI.ChatCompletionMessageParam => {
      switch (message.role) {
        case 'system': {
          return {
            role: 'system',
            content: message.content,
          };
        }

        case 'user': {
          return {
            role: 'user',
            content: message.content,
          };
        }

        case 'assistant': {
          return this.buildAssistantMessage(message);
        }

        case 'tool_result': {
          const { toolCallId } = message;
          if (typeof toolCallId !== 'string') {
            // 一般不会走到这里，走到这里就是代码 BUG。
            throw new TypeError(
              'tool_result message has no valid tool_call_id',
            );
          }

          return {
            role: 'tool',
            content: message.output,
            tool_call_id: toolCallId,
          };
        }

        default: {
          throw new TypeError('未知的消息角色');
        }
      }
    });

    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: msgs,
        stream: true,
        stream_options: {
          include_usage: true,
        },
        ...(tools.length > 0 ? { tools } : {}),
      },
      { signal: options?.signal },
    );

    // 推送 start 事件
    stream.push({ type: 'start', partial: output });

    type StreamingToolCallBlock = {
      streamIndex?: number;
      partialArgs?: string;
    } & ToolCall;

    type StreamingBlock = Text | Thinking | StreamingToolCallBlock;

    const blocks = output.content as StreamingBlock[];

    let textBlock: Text | undefined;
    let thinkingBlock: Thinking | undefined;
    const indexedToolCallBlocks = new Map<number, StreamingToolCallBlock>();
    // 处理文本消息块
    const ensureTextBlock = (): Text => {
      if (textBlock) {
        return textBlock;
      }

      textBlock = { type: 'text', text: '' };
      output.content.push(textBlock);
      // 推送 text_start 事件
      stream.push({
        type: 'text_start',
        index: output.content.indexOf(textBlock),
        partial: output,
      });
      return textBlock;
    };

    // 处理思考过程
    const ensureThinkingBlock = (thinkingReplayData?: string) => {
      if (!thinkingBlock) {
        thinkingBlock = {
          type: 'thinking',
          thinking: '',
          thinkingReplayData,
        };
        blocks.push(thinkingBlock);
        stream.push({
          type: 'thinking_start',
          index: blocks.indexOf(thinkingBlock),
          partial: output,
        });
      }

      return thinkingBlock;
    };

    // 处理工具调用消息块
    const ensureToolCallBlock = (
      delta: ToolCallDelta,
    ): StreamingToolCallBlock => {
      let block: StreamingToolCallBlock | undefined = indexedToolCallBlocks.get(
        delta.index,
      );
      if (!block) {
        block = {
          type: 'tool_call',
          id: delta.id ?? '',
          name: delta.function?.name ?? '',
          input: {},
          streamIndex: delta.index,
          partialArgs: '',
        };
        indexedToolCallBlocks.set(block.streamIndex!, block);
        blocks.push(block);
        stream.push({
          type: 'tool_call_start',
          index: blocks.indexOf(block),
          toolCall: block,
          partial: output,
        });
      }

      return block;
    };

    const finishBlock = (block: StreamingBlock) => {
      const index = blocks.indexOf(block);
      if (index === -1) {
        return;
      }

      switch (block.type) {
        case 'text': {
          stream.push({
            type: 'text_end',
            index,
            text: block,
            partial: output,
          });

          break;
        }

        case 'thinking': {
          stream.push({
            type: 'thinking_end',
            index,
            thinking: block,
            partial: output,
          });

          break;
        }

        case 'tool_call': {
          let input: Record<string, unknown> = {};
          if (block.partialArgs && block.partialArgs.trim().length > 0) {
            try {
              input = JSON.parse(block.partialArgs);
            } catch {
              // ignored
            }
          }

          block.input = input;
          // Finalize in-place
          delete block.partialArgs;
          delete block.streamIndex;
          stream.push({
            type: 'tool_call_end',
            index: blocks.indexOf(block),
            toolCall: block,
            partial: output,
          });

          break;
        }
        // No default
      }
    };

    let hasStopReason = false;

    for await (const chunk of response) {
      if (!chunk || typeof chunk !== 'object') {
        continue;
      }

      if (chunk.usage) {
        // TODO 处理使用情况数据
      }

      const choice = Array.isArray(chunk.choices)
        ? chunk.choices[0]
        : undefined;
      if (!choice) {
        continue;
      }

      if (choice.finish_reason) {
        const { stopReason, errorMessage } = this.convertStopReason(
          choice.finish_reason,
        );
        output.stopReason = stopReason;
        if (errorMessage) {
          output.errorMessage = errorMessage;
        }

        output.rawStopReason = choice.finish_reason;
        hasStopReason = true;
      }

      const { delta } = choice;
      // 文本
      if (delta?.content && delta.content.length > 0) {
        const block = ensureTextBlock();
        block.text += delta.content;
        stream.push({
          type: 'text_delta',
          index: output.content.indexOf(block),
          delta: delta.content,
          partial: output,
        });
      }

      // 工具调用
      if (delta?.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          const block = ensureToolCallBlock(toolCallDelta);
          // 协议中，只有 arguments 是增量字段，id 和 name 都是一次性的完整字符串。
          if (toolCallDelta.id) {
            block.id = toolCallDelta.id;
          }

          if (toolCallDelta.function?.name) {
            block.name = toolCallDelta.function.name;
          }

          if (toolCallDelta.function?.arguments) {
            block.partialArgs += toolCallDelta.function.arguments;
          }

          stream.push({
            type: 'tool_call_delta',
            index: blocks.indexOf(block),
            delta: toolCallDelta.function?.arguments ?? '',
            toolCall: block,
            partial: output,
          });
        }
      }

      // 提取思考内容
      const reasoningFields = [
        'reasoning',
        'reasoning_content',
        'reasoning_text',
      ];
      const deltaFields = choice.delta as Record<string, unknown>;
      for (const field of reasoningFields) {
        const value = deltaFields[field];
        if (typeof value === 'string' && value.length > 0) {
          const block = ensureThinkingBlock(field);
          block.thinking += value;
          stream.push({
            type: 'thinking_delta',
            index: blocks.indexOf(block),
            delta: value,
            partial: output,
          });
          break;
        }
      }
    }

    for (const block of blocks) {
      finishBlock(block);
    }

    if (output.stopReason === 'error') {
      throw new Error(
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- errorMessage 为空串时也要回退到默认信息
        output.errorMessage || 'Provider returned an error stop reason',
      );
    }

    if (output.stopReason === 'aborted') {
      throw new Error('Request was aborted');
    }

    if (!hasStopReason) {
      output.stopReason = output.content.some(
        block => block.type === 'tool_call',
      )
        ? 'tool_use'
        : 'stop';
    }

    stream.push({ type: 'done', reason: output.stopReason, message: output });
    stream.end();
  }

  private convertStopReason(
    reason: ChatCompletionChunk.Choice['finish_reason'] | string,
  ): {
    stopReason: StopReason;
    errorMessage?: string;
  } {
    if (reason === null || reason === undefined) {
      return { stopReason: 'stop' };
    }

    switch (reason) {
      case 'stop':
      case 'end': {
        return { stopReason: 'stop' };
      }

      case 'length': {
        return { stopReason: 'length' };
      }

      case 'function_call': {
        return { stopReason: 'error' };
      }

      case 'tool_calls': {
        return { stopReason: 'tool_use' };
      }

      case 'content_filter': {
        return {
          stopReason: 'error',
          errorMessage: 'Content filter triggered',
        };
      }

      case 'network_error': {
        return { stopReason: 'error', errorMessage: 'Network error' };
      }

      default: {
        return {
          stopReason: 'error',
          errorMessage: `Provider finish_reason: ${reason}`,
        };
      }
    }
  }

  private buildAssistantMessage(
    message: AssistantMessage,
  ): OpenAI.ChatCompletionAssistantMessageParam {
    const content: OpenAI.ChatCompletionContentPartText[] = [];
    const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
    for (const item of message.content) {
      switch (item.type) {
        case 'text': {
          content.push({
            type: 'text',
            text: item.text,
          });
          break;
        }

        case 'thinking': {
          // TODO 我不知道要不要传
          break;
        }

        case 'tool_call': {
          toolCalls.push({
            type: 'function',
            id: item.id,
            function: {
              name: item.name,
              arguments: item.input ? JSON.stringify(item.input) : '',
            },
          });
          break;
        }
        // No default
      }
    }

    return {
      role: 'assistant',
      content: content.length > 0 ? content : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  private makeJsonSchemaToolParameters(tool: AnyTool): FunctionParameters {
    return tool.inputSchema as FunctionParameters;
  }
}
