import type { AnyTool } from '../tools/types.ts';
import { EventStream } from '../utils/event-stream.ts';

// 调用模型时要声明的工具（模型只需要 schema，不需要 execute）
export type StreamOptions = {
  tools?: AnyTool[];
  signal?: AbortSignal;
};

// 大模型接口抽象
export interface ModelApi {
  stream(
    messages: Message[],
    options?: StreamOptions,
  ): AssistantMessageEventStream;
}

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
  input: Record<string, unknown>;
};

// 与 pi-ai 的 Usage 形状对齐（含成本与 reasoning token 数），适配层直传
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoning?: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
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
  // 工具原始输出；失败时的 error 单独存放，不并进 output
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
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
