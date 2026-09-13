import {type ToolCall} from '@bubble-code/tools/tool.js';

// LLM 消息角色
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

// 与模型交换的消息（协议格式，不含 UI 概念）
export type Message = {
  role: ChatRole;
  content: string;
  extra?: Record<string, unknown>;
};

// LLM 响应
export type Response =
  | {type: 'text_delta'; text: string} // 流式增量消息
  | {
      type: 'tool_call';
      toolCall: ToolCall;
    } // 工具调用
  | {type: 'usage'} // Token用量
  | {type: 'error'; error: Error}
  | {type: 'complete'};

// LLM 接口协议
export type Protocol = 'openai' | 'anthropic' | 'responses';

// 工具调用记录
export type ToolCallRecord = {
  id: string;
  name: string;
  arguments: string;
};
