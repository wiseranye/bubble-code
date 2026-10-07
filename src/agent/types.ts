import type {
  AgentMessage,
  Text,
  Thinking,
  ToolCall,
  ToolResultMessage,
} from '../llm/types.ts';
import type { ToolRegistry } from '../tools/tool.ts';

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
