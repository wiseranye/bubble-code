import type {
  AgentMessage,
  ModelApi,
  Text,
  Thinking,
  ToolCall,
  ToolResultMessage,
} from '../llm/types.ts';
import type { TodoStore } from '../todo/todo.ts';
import type { ToolSource } from '../tools/types.ts';
import type { UiContext } from '../ui/ui-context.ts';

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
  // 单个工具调用：完整接收时排队，获得执行槽位时开始
  | { type: 'tool_queued'; toolCall: ToolCall }
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
  tools: ToolSource;
  cwd: string;
  // 当前会话的通用 UI 能力；非交互运行时可以为空
  ui?: UiContext;
  // 会话中所有的消息
  messages: AgentMessage[];
  // 每个 Agent 独立的 TODO 状态；直接构造测试上下文时可以为空
  todoStore?: TodoStore;
};

export interface AgentState {
  modelApi?: ModelApi;
  set messages(messages: AgentMessage[]);
  get messages(): AgentMessage[];
}
