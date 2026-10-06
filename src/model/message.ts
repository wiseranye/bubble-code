import { type ToolCall } from '@bubble-code/tools/tool.js';

// 消息角色
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// 与模型交换的消息（协议格式，不含 UI 概念）
export type Message = {
  role: MessageRole;
  content: string;
  extra?: Record<string, unknown>;
};

// LLM 消息事件
export type MessageEvent =
  | { type: 'start' }
  // 响应
  | { type: 'text_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'text_end'; content: string }
  // 思考
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start'; content: string }
  // 工具
  | {
      type: 'tool_call';
      toolCall: ToolCall;
    }
  | { type: 'done' }
  | { type: 'error'; error: Error };

// LLM 接口协议
export type Protocol = 'anthropic' | 'openai-completion' | 'openai-responses';

// 工具调用记录
export type ToolCallRecord = {
  id: string;
  name: string;
  arguments: string;
};
