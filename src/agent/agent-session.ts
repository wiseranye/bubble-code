import type { Agent } from './agent.js';
import type { AgentEvent } from './types.js';

// UI 消息模型：和协议消息（AgentMessage）分离，带 id 和渲染状态
export type TextChatMessage = {
  id: number;
  role: 'system' | 'user' | 'assistant' | 'thinking';
  content: string;
};

export type ToolChatMessage = {
  id: number;
  role: 'tool';
  toolCallId: string;
  name: string;
  input: string;
  output: string;
  status: 'running' | 'done';
  success: boolean;
};

export type ChatMessage = TextChatMessage | ToolChatMessage;

// Session 事件：面向 UI 的 store 语义，与 AgentEvent 是两套词汇
export type AgentSessionEvent =
  | { type: 'message_added'; message: ChatMessage }
  | { type: 'message_updated'; message: ChatMessage }
  | { type: 'message_sealed'; message: ChatMessage }
  | { type: 'streaming_changed'; isStreaming: boolean };

type Listener = (event: AgentSessionEvent) => void;

// 流式文本段的归属：text_delta → assistant，thinking_delta → thinking
type TextBlockRole = 'assistant' | 'thinking';

export class AgentSession {
  private readonly listeners = new Set<Listener>();
  // 消息按时间顺序排列；已冻结的消息不会再被修改
  private readonly store: ChatMessage[] = [];
  private idCounter = 1;
  private generating = false;
  private abortController: AbortController | undefined;
  // 当前打开的流式文本段；角色切换、tool_start、turn_end、run_end 都会冻结它
  private openBlock: { id: number; role: TextBlockRole } | undefined;
  // toolCallId → Chat message id，用来把 tool_result 贴回对应的工具消息
  private readonly toolBlocks = new Map<string, number>();

  constructor(private readonly agent: Agent) {
    agent.subscribe(event => {
      this.handleAgentEvent(event);
    });
    // 欢迎语在 UI 订阅之前就存在，启动时直接补建视图
    this.store.push({
      id: this.idCounter++,
      role: 'system',
      content: 'Bubble Code — 输入问题，Enter 发送。',
    });
  }

  get messages(): readonly ChatMessage[] {
    return this.store;
  }

  get isStreaming(): boolean {
    return this.generating;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(text: string): void {
    const content = text.trim();
    if (content === '' || this.generating) {
      return;
    }

    const userMessage: TextChatMessage = {
      id: this.idCounter++,
      role: 'user',
      content,
    };
    this.store.push(userMessage);
    this.emit({ type: 'message_added', message: userMessage });
    // 用户消息一提交就是终态
    this.emit({ type: 'message_sealed', message: userMessage });

    this.generating = true;
    this.openBlock = undefined;
    this.toolBlocks.clear();
    this.emit({ type: 'streaming_changed', isStreaming: true });

    const controller = new AbortController();
    this.abortController = controller;
    void this.run(content, controller);
  }

  cancel(): void {
    // 只中断本次 run；和 agent 的订阅关系是长期的，不能动
    this.abortController?.abort();
  }

  private async run(
    content: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      await this.agent.prompt(content, { signal: controller.signal });
    } catch (error: unknown) {
      // 正常失败都走 run_end 事件；这里是 agent 层直接抛错的兜底
      if (this.generating && !controller.signal.aborted) {
        const detail = error instanceof Error ? error.message : String(error);
        this.appendText('assistant', `\n\n[生成出错] ${detail}`);
      }
    } finally {
      // run_end 没收到（比如 emit 抛错）时兜底收口，streaming 标志必须配对
      if (this.generating) {
        this.finishRun();
      }
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta': {
        this.appendText('assistant', event.delta);
        break;
      }

      case 'thinking_delta': {
        this.appendText('thinking', event.delta);
        break;
      }

      case 'tool_start': {
        // 工具调用开始，说明上一段文本/思考已经写完，可以冻结
        this.sealOpenBlock();
        const { toolCall } = event;
        const message: ToolChatMessage = {
          id: this.idCounter++,
          role: 'tool',
          toolCallId: toolCall.id,
          name: toolCall.name,
          input: JSON.stringify(toolCall.input),
          output: '',
          status: 'running',
          success: true,
        };
        this.toolBlocks.set(toolCall.id, message.id);
        this.store.push(message);
        this.emit({ type: 'message_added', message });
        break;
      }

      case 'tool_result': {
        const id = this.toolBlocks.get(event.toolCallId);
        if (id === undefined) {
          break;
        }

        const updated = this.update(id, message =>
          message.role === 'tool'
            ? {
                ...message,
                output: event.result.output,
                success: event.success,
                status: 'done',
              }
            : message,
        );
        if (updated !== undefined) {
          this.emit({ type: 'message_sealed', message: updated });
        }

        break;
      }

      case 'turn_end': {
        // 一轮结束：冻结当前段，下一轮的文本另起一条消息
        this.sealOpenBlock();
        break;
      }

      case 'run_end': {
        if (event.reason === 'error' || event.reason === 'max_steps') {
          const detail = event.error?.message ?? '未知错误';
          const label = event.reason === 'max_steps' ? '达到最大步数' : '出错';
          this.appendText('assistant', `\n\n[${label}] ${detail}`);
        }

        this.finishRun();
        break;
      }

      default: {
        // run_start / turn_start：UI 目前没有对应表现
        break;
      }
    }
  }

  private finishRun(): void {
    this.sealOpenBlock();
    // 取消或异常退出时，可能还有工具消息停在「执行中」
    for (const message of this.store) {
      if (message.role === 'tool' && message.status === 'running') {
        const updated = this.update(message.id, current =>
          current.role === 'tool'
            ? { ...current, status: 'done', success: false }
            : current,
        );
        if (updated !== undefined) {
          this.emit({ type: 'message_sealed', message: updated });
        }
      }
    }

    this.generating = false;
    this.abortController = undefined;
    this.emit({ type: 'streaming_changed', isStreaming: false });
  }

  // 流式文本按段累积：第一个增量创建消息，之后的增量原地追加；
  // 角色和当前段不同时，先冻结旧段再开新段
  private appendText(role: TextBlockRole, delta: string): void {
    const open = this.openBlock;
    if (open !== undefined && open.role === role) {
      this.update(open.id, message =>
        message.role === role
          ? { ...message, content: message.content + delta }
          : message,
      );
      return;
    }

    this.sealOpenBlock();
    const message: TextChatMessage = {
      id: this.idCounter++,
      role,
      content: delta,
    };
    this.openBlock = { id: message.id, role };
    this.store.push(message);
    this.emit({ type: 'message_added', message });
  }

  private sealOpenBlock(): void {
    const open = this.openBlock;
    this.openBlock = undefined;
    if (open === undefined) {
      return;
    }

    const message = this.store.find(entry => entry.id === open.id);
    if (message !== undefined) {
      this.emit({ type: 'message_sealed', message });
    }
  }

  private update(
    id: number,
    apply: (message: ChatMessage) => ChatMessage,
  ): ChatMessage | undefined {
    const index = this.store.findIndex(message => message.id === id);
    const current = this.store[index];
    if (current === undefined) {
      return undefined;
    }

    const next = apply(current);
    this.store[index] = next;
    this.emit({ type: 'message_updated', message: next });
    return next;
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
