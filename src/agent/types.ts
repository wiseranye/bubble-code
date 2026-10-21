import type {
  AgentMessage,
  ModelApi,
  Text,
  Thinking,
  ToolCall,
  ToolResultMessage,
} from '../llm/types.ts';
import type { ToolRegistry } from '../tools/types.ts';

// Agent 事件
export type AgentEvent =
  // Run 生命周期：一次 prompt 的完整处理
  | { type: 'run_start' }
  | {
      type: 'run_end';
      reason: 'complete' | 'aborted' | 'error';
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
    }
  // 压缩生命周期：压缩由 AgentSession 驱动，事件经 handleAgentEvent 统一到 UI
  | { type: 'compaction_start' }
  | { type: 'compaction_end'; summarizedCount: number };

export type AgentContext = {
  // 工具注册中心
  tools: ToolRegistry;
  // 会话中所有的消息
  messages: AgentMessage[];
};

export interface AgentState {
  modelApi?: ModelApi;
  set messages(messages: AgentMessage[]);
  get messages(): AgentMessage[];
}
