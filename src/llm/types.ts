import { setTimeout as sleep } from 'node:timers/promises';
import type { Tool } from '../tools/tool.ts';
import { EventStream } from '../utils/event-stream.ts';

// 调用模型时要声明的工具（模型只需要 schema，不需要 execute）
export type StreamOptions = {
  tools?: Tool[];
  signal?: AbortSignal;
};

export type Model = {
  stream(
    messages: Message[],
    options?: StreamOptions,
  ): AssistantMessageEventStream;
};

export type Text = {
  type: 'text';
  text: string;
};

export type Thinking = {
  type: 'thinking';
  thinking: string;
  thinkingReplayData?: string;
};

export type ToolCall = {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, any>;
};

export type Usage = {
  input: number;
  output: number;
  cachedRead: number;
  cachedWrite: number;
  totalTokens: number;
};

export type AssistantMessage = {
  role: 'assistant';
  content: Array<Text | Thinking | ToolCall>;
  usage?: Usage;
  stopReason: StopReason;
  rawStopReason?: string;
  timestamp: number; // Unix timestamp in milliseconds
  errorMessage?: string;
};

export type UserMessage = {
  role: 'user';
  content: string;
  timestamp: number; // Unix timestamp in milliseconds
};

export type SystemPrompt = {
  role: 'system';
  content: string;
};

export type ToolResultMessage = {
  role: 'tool_result';
  toolName: string;
  toolCallId: string;
  output: string;
  timestamp: number;
};

export type Message =
  | UserMessage
  | SystemPrompt
  | AssistantMessage
  | ToolResultMessage;

// 代表每一个 agent loop 的消息
export type AgentMessage = Message;

// 结束原因
export type StopReason = 'stop' | 'length' | 'error' | 'aborted' | 'tool_use';

// LLM 消息事件
export type StreamChunkEvent =
  // 流开始
  | { type: 'start'; partial: AssistantMessage }
  // 文本
  | { type: 'text_start'; index: number; partial: AssistantMessage }
  | {
      type: 'text_delta';
      index: number;
      delta: string;
      partial: AssistantMessage;
    }
  | { type: 'text_end'; index: number; text: Text; partial: AssistantMessage }
  // 思考
  | { type: 'thinking_start'; index: number; partial: AssistantMessage }
  | {
      type: 'thinking_delta';
      index: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: 'thinking_end';
      index: number;
      thinking: Thinking;
      partial: AssistantMessage;
    }
  // 工具
  | {
      type: 'tool_call_start';
      index: number;
      toolCall: ToolCall;
      partial: AssistantMessage;
    }
  | {
      type: 'tool_call_delta';
      index: number;
      delta: string;
      toolCall: ToolCall;
      partial: AssistantMessage;
    }
  | {
      type: 'tool_call_end';
      index: number;
      toolCall: ToolCall;
      partial: AssistantMessage;
    }
  | {
      type: 'done';
      reason: Extract<StopReason, 'stop' | 'length' | 'tool_use'>;
      message: AssistantMessage;
    }
  | {
      type: 'error';
      reason: Extract<StopReason, 'aborted' | 'error'>;
      error: Error;
      message: AssistantMessage;
    };

export class AssistantMessageEventStream extends EventStream<StreamChunkEvent> {
  constructor() {
    // done / error 事件即流结束
    super(event => event.type === 'done' || event.type === 'error');
  }
}

// A mock implementation used until a real model backend is wired up. It
// streams a canned reply token-by-token so the UI behaves like a real
// streaming agent.
export class MockModel implements Model {
  constructor(private readonly delay: number = 20) {}

  stream(_: Message[]): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();

    (async () => {
      const output: AssistantMessage = {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
        timestamp: Date.now(),
      };

      const reply = `mock reply: 这是虚假的回复`;
      const block: Text = { type: 'text', text: '' };
      output.content.push(block);

      stream.push({ type: 'start', partial: output });
      stream.push({ type: 'text_start', index: 0, partial: output });

      for (const token of reply.split(/(\s+)/)) {
        if (token === '') {
          continue;
        }

        block.text += token;

        stream.push({
          type: 'text_delta',
          index: 0,
          delta: token,
          partial: output,
        });

        if (this.delay > 0) {
          // The per-token delay is intentional: it simulates streaming.
          // eslint-disable-next-line no-await-in-loop
          await sleep(this.delay);
        }
      }

      stream.push({ type: 'text_end', index: 0, text: block, partial: output });
      stream.push({ type: 'done', reason: 'stop', message: output });
      stream.end();
    })();

    return stream;
  }
}
