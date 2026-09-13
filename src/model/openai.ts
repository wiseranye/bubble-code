import OpenAI from 'openai';
import {type Model, type StreamOptions} from './llm.js';
import {type Response, type Message, type ToolCallRecord} from './message.js';
import {parseToolInput} from '@bubble-code/utils/tool-input.js';

export class OpenAiModel implements Model {
  private readonly client: OpenAI;

  private readonly model: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey,
    });
    this.model = model;
  }

  async *stream(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncGenerator<Response> {
    // build tools
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
    // build messages
    const msgs = messages.map((message): OpenAI.ChatCompletionMessageParam => {
      switch (message.role) {
        case 'system':
        case 'user':
        case 'assistant':
          const toolCalls = buildToolCalls(message.extra?.['tool_calls']);
          // TODO 完全看不懂这是啥意思
          return {
            role: message.role,
            content: message.content,
            ...(toolCalls ? {tool_calls: toolCalls} : {}),
          };
        case 'tool': {
          const toolCallId = message.extra?.['tool_call_id'];
          if (typeof toolCallId !== 'string') {
            // 一般不会走到这里，走到这里就是代码 BUG。
            throw new Error('tool 消息缺少 tool_call_id');
          }
          return {
            role: 'tool',
            content: message.content,
            tool_call_id: toolCallId,
          };
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
    const toolCalls = new Map<
      number,
      {
        id: string;
        name: string;
        arguments: string;
      }
    >();
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
          const index = toolCallDelta.index;
          let tolCall = toolCalls.get(index);
          if (!tolCall) {
            tolCall = {
              id: toolCallDelta.id ?? '',
              name: toolCallDelta.function?.name ?? '',
              arguments: toolCallDelta.function?.arguments ?? '',
            };
            toolCalls.set(index, tolCall);
          } else {
            if (toolCallDelta.id) {
              tolCall.id += toolCallDelta.id;
            }
            if (toolCallDelta.function?.name) {
              tolCall.name += toolCallDelta.function.name;
            }
            if (toolCallDelta.function?.arguments) {
              tolCall.arguments += toolCallDelta.function.arguments;
            }
          }
        }
      }
    }
    // stream 结束后统一
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
