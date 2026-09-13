import OpenAI from 'openai';
import {parseToolInput} from '@bubble-code/utils/tool-input.js';
import {type Model, type StreamOptions} from './llm.js';
import {type Response, type Message, type ToolCallRecord} from './message.js';

// 流式工具调用的累积结果
type ToolCallAccumulator = {
  id: string;
  name: string;
  arguments: string;
};

// OpenAI 的工具调用分片只有 index 稳定，其余字段可能只在一部分分片里出现
type ToolCallDelta = {
  index: number;
  id?: string;
  function?: {name?: string; arguments?: string};
};

function mergeToolCallDelta(
  toolCalls: Map<number, ToolCallAccumulator>,
  delta: ToolCallDelta,
): void {
  const existing = toolCalls.get(delta.index);
  if (existing === undefined) {
    toolCalls.set(delta.index, {
      id: delta.id ?? '',
      name: delta.function?.name ?? '',
      arguments: delta.function?.arguments ?? '',
    });
    return;
  }

  existing.id += delta.id ?? '';
  existing.name += delta.function?.name ?? '';
  existing.arguments += delta.function?.arguments ?? '';
}

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

  async *stream(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncGenerator<Response> {
    // Build tools
    const tools: OpenAI.ChatCompletionTool[] = (options?.tools ?? []).map(
      tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }),
    );
    // Build messages
    const msgs = messages.map((message): OpenAI.ChatCompletionMessageParam => {
      switch (message.role) {
        case 'system':
        case 'user':
        case 'assistant': {
          const toolCalls = buildToolCalls(message.extra?.['tool_calls']);
          // Assistant 消息要把 tool_calls 原样写回协议，否则下一轮请求对不上
          return {
            role: message.role,
            content: message.content,
            ...(toolCalls ? {tool_calls: toolCalls} : {}),
          };
        }

        case 'tool': {
          const toolCallId = message.extra?.['tool_call_id'];
          if (typeof toolCallId !== 'string') {
            // 一般不会走到这里，走到这里就是代码 BUG。
            throw new TypeError('tool 消息缺少 tool_call_id');
          }

          return {
            role: 'tool',
            content: message.content,
            tool_call_id: toolCallId,
          };
        }

        default: {
          throw new TypeError('未知的消息角色');
        }
      }
    });
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: msgs,
        stream: true,
        stream_options: {
          include_usage: true,
        },
        ...(tools.length > 0 ? {tools} : {}),
      },
      {signal: options?.signal},
    );
    // 所有的工具调用
    const toolCalls = new Map<number, ToolCallAccumulator>();
    for await (const part of stream) {
      const delta = part.choices[0]?.delta;
      // 文本
      if (delta?.content) {
        yield {
          type: 'text_delta',
          text: delta.content,
        };
      }

      // 工具调用
      if (delta?.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          mergeToolCallDelta(toolCalls, toolCallDelta);
        }
      }
    }

    // Stream 结束后统一
    for (const toolCall of toolCalls.values()) {
      const input = parseToolInput(toolCall.arguments);
      if (input.ok) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: toolCall.id,
            name: toolCall.name,
            input: input.value,
            inputRaw: toolCall.arguments,
          },
        };
      } else {
        yield {
          type: 'error',
          error: input.error,
        };
      }
    }
  }
}

function buildToolCalls(
  value: unknown,
): OpenAI.ChatCompletionMessageFunctionToolCall[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  return value.map(item => {
    const record = item as ToolCallRecord;
    return {
      id: record.id,
      type: 'function',
      function: {
        name: record.name,
        arguments: record.arguments,
      },
    };
  });
}
