import { type ToolRegistry } from 'src/tools/tool.js';

export type UserMessage = {
  role: 'user';
  content: string;
  timestamp: number; // Unix timestamp in milliseconds
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

export type SystemPrompt = {
  role: 'system';
  content: string;
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

// Agent 事件
export type AgentEvent =
  // Run 生命周期：一次 prompt 的完整处理
  | { type: 'run_start' }
  | {
      type: 'run_end';
      reason: 'complete' | 'aborted' | 'max_steps' | 'error';
      messages: AgentMessage[];
      error?: Error;
    }
  // Turn 生命周期：一轮 model.stream + 工具执行
  | { type: 'turn_start' }
  | {
      type: 'turn_end';
      message?: AgentMessage;
      toolResults: ToolResultMessage[];
    }
  // 流式增量
  | { type: 'text_delta'; delta: string }
  | { type: 'text_end'; text: Text }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end'; thinking: Thinking }
  // 单个工具调用
  | { type: 'tool_start'; toolCall: ToolCall }
  | {
      type: 'tool_result';
      toolCallId: string;
      result: ToolResultMessage;
      success: boolean;
    };

export type AgentContext = {
  // 工具注册中心
  tools: ToolRegistry;
  // 会话中所有的消息
  messages: AgentMessage[];
};
