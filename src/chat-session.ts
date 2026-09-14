import { type Agent } from './agent/agent.js';
import { type AgentEvent } from './agent/events.js';

// 文本消息（system / user / assistant）
export type TextChatMessage = {
  id: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
};

// 工具调用消息：一次调用一条，结果回来后在原地更新
export type ToolChatMessage = {
  id: number;
  role: 'tool';
  toolCallId: string;
  name: string;
  // 模型给出的原始参数（JSON 字符串）
  input: string;
  // 执行结果，未完成时为空串
  output: string;
  status: 'running' | 'done';
  success: boolean;
};

export type ChatMessage = TextChatMessage | ToolChatMessage;

// 会话对外广播的事件。UI 只依赖这些事件，不直接改消息
export type ChatSessionEvent =
  | {type: 'message_added'; message: ChatMessage}
  | {type: 'message_updated'; message: ChatMessage}
  | {type: 'message_sealed'; message: ChatMessage}
  | {type: 'streaming_changed'; isStreaming: boolean};

type Listener = (event: ChatSessionEvent) => void;

const welcomeMessage: TextChatMessage = {
  id: 0,
  role: 'system',
  content: 'Bubble Code · 编码智能体\n输入你的需求，按 Enter 发送。',
};

export class ChatSession {
  private readonly listeners = new Set<Listener>();
  // 消息按时间顺序排列；已冻结的消息不会再被修改
  private readonly store: ChatMessage[] = [welcomeMessage];
  private idCounter = 1;
  private generating = false;
  private abortController: AbortController | undefined;
  // 当前正在流式接收的 assistant 消息；遇到工具调用就置空，之后的文本另起一段
  private assistantBlock: number | undefined;
  // Tool_call_id → Chat message id，用来把 tool_result 贴回对应的工具消息
  private readonly toolBlocks = new Map<string, number>();

  constructor(private readonly agent: Agent) {
    this.agent.subscribe((event, _) => {
      this.handleAgentEvent(event)
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
    return () => {
      this.listeners.delete(listener);
    };
  }

  send(text: string): void {
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
    this.emit({type: 'message_added', message: userMessage});
    // 用户消息一提交就是终态
    this.emit({type: 'message_sealed', message: userMessage});

    this.generating = true;
    this.assistantBlock = undefined;
    this.toolBlocks.clear();
    this.emit({type: 'streaming_changed', isStreaming: true});

    const controller = new AbortController();
    this.abortController = controller;
    void this.generate(content, controller);
  }

  cancel(): void {
    this.abortController?.abort();
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'assistant_delta': {
        this.appendAssistantText(event.text);
        break;
      }

      case 'tool_start': {
        // 工具调用开始，说明上一段文本已经写完了，可以冻结
        this.sealAssistantBlock();
        const message: ToolChatMessage = {
          id: this.idCounter++,
          role: 'tool',
          toolCallId: event.tool_call_id,
          name: event.name,
          input: event.input,
          output: '',
          status: 'running',
          success: true,
        };
        this.toolBlocks.set(event.tool_call_id, message.id);
        this.store.push(message);
        this.emit({type: 'message_added', message});
        break;
      }

      case 'tool_result': {
        const id = this.toolBlocks.get(event.tool_call_id);
        if (id === undefined) {
          break;
        }

        const updated = this.update(id, message =>
          message.role === 'tool'
            ? {
                ...message,
                output: event.output,
                success: event.success,
                status: 'done',
              }
            : message,
        );
        if (updated !== undefined) {
          this.emit({type: 'message_sealed', message: updated});
        }

        break;
      }

      case 'error': {
        this.appendAssistantText(`\n\n[出错] ${event.error.message}`);
        break;
      }

      default: {
        break;
      }
    }
  }

  private async generate(
    content: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      await this.agent.prompt(content, {
        signal: controller.signal,
      });
    } catch (error: unknown) {
      // 用户主动取消时抛的是 AbortError，不当成错误显示
      if (!controller.signal.aborted) {
        const detail = error instanceof Error ? error.message : String(error);
        this.appendAssistantText(`\n\n[生成出错] ${detail}`);
      }
    } finally {
      this.sealAssistantBlock();
      // 取消或异常退出时，可能还有工具消息停在「执行中」
      for (const message of this.store) {
        if (message.role === 'tool' && message.status === 'running') {
          const updated = this.update(message.id, current =>
            current.role === 'tool'
              ? {...current, status: 'done', success: false}
              : current,
          );
          if (updated !== undefined) {
            this.emit({type: 'message_sealed', message: updated});
          }
        }
      }

      this.generating = false;
      this.abortController = undefined;
      this.emit({type: 'streaming_changed', isStreaming: false});
    }
  }

  // Assistant 文本按段累积：第一次增量创建消息，之后的增量原地追加
  private appendAssistantText(delta: string): void {
    const id = this.assistantBlock;
    if (id === undefined) {
      const message: TextChatMessage = {
        id: this.idCounter++,
        role: 'assistant',
        content: delta,
      };
      this.assistantBlock = message.id;
      this.store.push(message);
      this.emit({type: 'message_added', message});
      return;
    }

    this.update(id, message =>
      message.role === 'tool'
        ? message
        : {...message, content: message.content + delta},
    );
  }

  private sealAssistantBlock(): void {
    const id = this.assistantBlock;
    this.assistantBlock = undefined;
    if (id === undefined) {
      return;
    }

    const message = this.store.find(entry => entry.id === id);
    if (message !== undefined) {
      this.emit({type: 'message_sealed', message});
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
    this.emit({type: 'message_updated', message: next});
    return next;
  }

  private emit(event: ChatSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
