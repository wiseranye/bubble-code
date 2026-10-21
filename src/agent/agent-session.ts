import type { AgentMessage, ModelApi, UserMessage } from '../llm/types.ts';
import type { Agent } from './agent.ts';
import {
  buildSummarizationMessages,
  type CompactConfig,
  collectSummary,
  DEFAULT_COMPACT_CONFIG,
  estimateContextTokens,
  findRetainedStart,
  makeSummaryMessage,
  projectSessionEntries,
} from './compaction.ts';
import { SessionManager, type SessionMessageEntry } from './session-manager.ts';
import type { AgentEvent } from './types.ts';

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
  error?: string;
  metadata?: Record<string, unknown>;
  status: 'running' | 'done';
  success: boolean;
};

export type ChatMessage = TextChatMessage | ToolChatMessage;

// Session 事件：面向 UI 的 store 语义，与 AgentEvent 是两套词汇
export type AgentSessionEvent =
  | { type: 'message_added'; message: ChatMessage }
  | { type: 'message_updated'; message: ChatMessage }
  | { type: 'message_sealed'; message: ChatMessage }
  | { type: 'streaming_changed'; isStreaming: boolean }
  // 压缩期间 UI 只禁用输入，不动 Bubbling 指示器（消息区有「压缩中」行）
  | { type: 'compaction_changed'; isCompacting: boolean };

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
  // 键为 toolCallId、值为 Chat message id，用来把 tool_result 贴回对应的工具消息
  private readonly toolBlocks = new Map<string, number>();

  private readonly agent: Agent;
  private readonly unsubscribeAgent: () => void;

  private readonly sessionManager: SessionManager;

  // 压缩配置与状态；contextWindow 跟随 /model 切换
  private compactConfig: CompactConfig;
  // 协议消息对象 → 会话文件条目 id：压缩条目的 firstRetainedEntryId 靠它定位。
  // 用对象身份做键（turn_end 事件里的消息和进 state 的是同一引用），
  // 不受 run 中途 state 与文件数量错位的影响
  private readonly entryIds = new WeakMap<AgentMessage, string>();
  // 上一次压缩的摘要；undefined 表示还没压缩过
  private previousSummary: string | undefined;
  // 距上次压缩新增的消息数：手动压缩的「没有新消息」守卫
  private messagesSinceCompaction = 0;
  // 当前 run 新增的消息对象：循环内压缩时靠它把 newMessages 从 state 投影里剔出去
  // （它们由 runAgentLoop 在 run 结束时统一 push 进 state）
  private currentRunMessages = new Set<AgentMessage>();
  // 自动压缩失败后停止重试，直到新一轮产生真实 usage
  private autoCompactFailed = false;
  private compacting = false;
  private compactionController: AbortController | undefined;
  // 压缩进行中插在消息区的临时行：结束时原地更新为结果文案（标记/失败/取消）
  private compactionNotice: TextChatMessage | undefined;

  constructor(
    agent: Agent,
    sessionFile?: string,
    compactConfig: CompactConfig = DEFAULT_COMPACT_CONFIG,
  ) {
    this.agent = agent;
    this.compactConfig = compactConfig;
    this.unsubscribeAgent = agent.subscribe(event => {
      this.handleAgentEvent(event);
    });
    this.sessionManager = new SessionManager(process.cwd(), sessionFile);
    if (sessionFile === undefined) {
      // 欢迎语在 UI 订阅之前就存在，启动时直接补建视图
      this.store.push({
        id: this.idCounter++,
        role: 'system',
        content: 'Bubble Code — 输入问题，Enter 发送。',
      });
    } else {
      this.restoreSession();
    }
  }

  // 从会话文件恢复：协议历史按压缩投影重建（摘要取代被压缩的前缀），
  // 聊天记录重放全部条目——被摘要的消息在界面上仍然可见，压缩点插入标记
  private restoreSession(): void {
    const projection = projectSessionEntries(this.sessionManager.entries());
    this.previousSummary = projection.summary;
    this.messagesSinceCompaction = projection.messagesSinceCompaction;

    if (projection.summary !== undefined) {
      this.agent.state.messages.push(makeSummaryMessage(projection.summary));
    }

    const normalized = normalizeRestoredPairs(
      projection.contextEntries.map(entry => ({
        id: entry.id,
        message: entry.message,
      })),
    );
    for (const { id, message } of normalized) {
      this.entryIds.set(message, id);
      this.agent.state.messages.push(message);
    }

    // tool_result 贴回对应的工具消息，键为 toolCallId。
    // 转录重放同样走顺序修复（旧版本会把 tool_result 写在 assistant 之前），
    // 以压缩标记为界分段整理，标记位置不动
    const toolMessages = new Map<string, ToolChatMessage>();
    let segment: SessionMessageEntry[] = [];
    const flushSegment = (): void => {
      const normalized = normalizeRestoredPairs(
        segment.map(entry => ({ id: entry.id, message: entry.message })),
      );
      for (const { message } of normalized) {
        this.appendRestoredMessage(message, toolMessages);
      }
      segment = [];
    };
    for (const item of projection.transcript) {
      if (item.kind === 'compaction') {
        flushSegment();
        this.store.push({
          id: this.idCounter++,
          role: 'system',
          content: compactionMarkerText(item.entry.summarizedCount),
        });
        continue;
      }

      segment.push(item.entry);
    }
    flushSegment();
  }

  private appendRestoredMessage(
    message: AgentMessage,
    toolMessages: Map<string, ToolChatMessage>,
  ): void {
    switch (message.role) {
      case 'user': {
        this.store.push({
          id: this.idCounter++,
          role: 'user',
          content: message.content,
        });
        break;
      }

      case 'assistant': {
        for (const block of message.content) {
          if (block.type === 'text') {
            this.store.push({
              id: this.idCounter++,
              role: 'assistant',
              content: block.text,
            });
          } else if (block.type === 'thinking') {
            // 纯空白思考（Kimi 思考流会发 "\n\n" 这样的 delta）不建消息，
            // 否则恢复出来的会话里它显示为一条空消息
            if (block.thinking.trim() === '') {
              continue;
            }

            this.store.push({
              id: this.idCounter++,
              role: 'thinking',
              content: block.thinking,
            });
          } else {
            // 恢复的会话不在执行中，工具消息直接是终态；成功与否没有持久化，按成功展示，
            // 另外两个展示字段由后面的 tool_result 补上（output、metadata）
            const toolMessage: ToolChatMessage = {
              id: this.idCounter++,
              role: 'tool',
              toolCallId: block.id,
              name: block.name,
              input: JSON.stringify(block.input),
              output: '',
              status: 'done',
              success: true,
            };
            toolMessages.set(block.id, toolMessage);
            this.store.push(toolMessage);
          }
        }
        break;
      }

      case 'tool_result': {
        const toolMessage = toolMessages.get(message.toolCallId);
        if (toolMessage !== undefined) {
          toolMessage.output = message.output;
          // metadata 里有 diff 这类展示数据，丢了就只剩无行号的兜底渲染
          if (message.metadata !== undefined) {
            toolMessage.metadata = message.metadata;
          }
        }
        break;
      }

      default: {
        break;
      }
    }
  }

  get messages(): readonly ChatMessage[] {
    return this.store;
  }

  get isStreaming(): boolean {
    return this.generating;
  }

  get isCompacting(): boolean {
    return this.compacting;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(text: string): void {
    const content = text.trim();
    if (content === '' || this.generating || this.compacting) {
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
    // 只中断本次 run / 压缩；和 agent 的订阅关系是长期的，不能动
    this.abortController?.abort();
    this.compactionController?.abort();
  }

  // /model 切换模型：替换 modelApi、compactConfig 的 contextWindow 跟随新模型。
  // 只在非生成态调用（UI 层守卫），不存在 run 中途改历史的问题
  setModel(modelApi: ModelApi, contextWindow: number): void {
    // 无条件剥掉历史 thinking 块的回放签名：旧 provider 的签名回放给新 provider
    // 必然无效（Anthropic 报 400 invalid signature）；剥掉后 pi 会把无签名
    // thinking 转成纯文本回放，同 provider 切换也一样处理，代价可接受
    for (const message of this.agent.state.messages) {
      if (message.role !== 'assistant') {
        continue;
      }

      for (const block of message.content) {
        if (block.type === 'thinking') {
          block.thinkingReplayData = undefined;
        }
      }
    }

    this.agent.state.modelApi = modelApi;
    this.compactConfig = { ...this.compactConfig, contextWindow };
  }

  // 给用户的即时系统提示（比如命令不可用的原因），不发给模型
  notify(content: string): void {
    this.appendSystemMessage(content);
  }

  // /new 替换会话时调用：退订 agent 事件，旧会话不再接收任何后续事件。
  // 返回写入落盘的 Promise：/resume 重读同一个会话文件前必须 await
  dispose(): Promise<void> {
    this.unsubscribeAgent();
    return this.sessionManager.close();
  }

  private async run(
    content: string,
    controller: AbortController,
  ): Promise<void> {
    // 用户消息由这里构造、落盘、登记条目 id，再传给 agent：
    // 循环内压缩的保留切点可能落在它上面，必须是已登记的同一个对象
    const userMessage: UserMessage = {
      role: 'user',
      content: content,
      timestamp: Date.now(),
    };
    const userEntryId = this.sessionManager.appendMessage(userMessage);
    this.entryIds.set(userMessage, userEntryId);
    this.messagesSinceCompaction++;
    this.currentRunMessages = new Set([userMessage]);
    try {
      await this.agent.prompt(userMessage, {
        signal: controller.signal,
        // 每个 turn 的请求前检查点：超阈值就地在循环内压缩
        beforeRequest: messages =>
          this.compactBeforeRequest(messages, controller.signal),
      });
    } catch (error: unknown) {
      // 正常失败都走 run_end 事件；这里是 agent 层直接抛错的兜底
      if (this.generating && !controller.signal.aborted) {
        const detail = error instanceof Error ? error.message : String(error);
        this.appendText('assistant', `\n\n[生成出错] ${detail}`);
      }
    } finally {
      this.currentRunMessages = new Set();
      // 收不到 run_end（比如 emit 抛错）时兜底收口，streaming 标志必须配对
      if (this.generating) {
        this.finishRun();
      }
    }
  }

  // 手动压缩（/compact）：忽略阈值，但受守卫限制
  async compact(): Promise<void> {
    if (this.generating || this.compacting) {
      this.notify('请等待当前会话结束');
      return;
    }
    if (this.agent.state.modelApi === undefined) {
      this.notify('未配置模型，无法压缩上下文');
      return;
    }
    if (
      this.previousSummary !== undefined &&
      this.messagesSinceCompaction === 0
    ) {
      this.notify('会话已压缩过，没有新的消息需要压缩');
      return;
    }

    await this.compactInternal('manual');
  }

  // agent-loop 的请求前检查点：每个 turn 的 stream 之前测量，超阈值就地在循环内压缩。
  // 返回原数组引用表示没有变动；压缩成功返回替换后的完整消息列表
  private async compactBeforeRequest(
    messages: AgentMessage[],
    signal: AbortSignal,
  ): Promise<AgentMessage[]> {
    if (this.compacting || this.autoCompactFailed) {
      return messages;
    }
    if (this.agent.state.modelApi === undefined) {
      return messages;
    }
    const { contextWindow, threshold } = this.compactConfig;
    if (estimateContextTokens(messages) <= threshold * contextWindow) {
      return messages;
    }

    const projected = await this.compactInternal('auto', signal, messages);
    return projected ?? messages;
  }

  // 压缩主流程：摘要侧信道成功后才动历史；失败/取消时历史原样保留。
  // 返回替换后的完整消息列表；没有发生压缩（含守卫拒绝与失败）时返回 undefined
  private async compactInternal(
    mode: 'auto' | 'manual',
    runSignal?: AbortSignal,
    messages: AgentMessage[] = this.agent.state.messages,
  ): Promise<AgentMessage[] | undefined> {
    const modelApi = this.agent.state.modelApi;
    if (modelApi === undefined) {
      return undefined;
    }

    // 有旧摘要时它是 messages[1]，本身不进可摘要区间（摘要文本单独喂给侧信道）
    const minIndex = this.previousSummary !== undefined ? 2 : 1;
    const retainBudget =
      this.compactConfig.retainRatio * this.compactConfig.contextWindow;
    let retainedStart = findRetainedStart(messages, retainBudget, minIndex);
    if (retainedStart <= minIndex && mode === 'manual') {
      // 手动压缩没有长度守卫：保留预算装不下时回退为只保留最后一轮
      // （摘要到最后一条 user 消息为止；user 不是 tool_result，无需配对调整）
      retainedStart = lastUserIndex(messages, minIndex);
    }

    if (retainedStart <= minIndex) {
      // 可摘要区间为空（比如会话只有 system + 一条 user）：静默返回
      return undefined;
    }

    const firstRetained = messages[retainedStart];
    const firstRetainedEntryId =
      firstRetained === undefined
        ? undefined
        : this.entryIds.get(firstRetained);
    if (firstRetainedEntryId === undefined) {
      // 映射缺失属内部异常：不动历史
      if (mode === 'manual') {
        this.notify('上下文压缩失败：内部状态缺失');
      } else {
        this.autoCompactFailed = true;
      }
      return undefined;
    }

    const summarized = messages.slice(minIndex, retainedStart);
    const sideChannel = buildSummarizationMessages(
      this.previousSummary,
      summarized,
    );

    const controller = new AbortController();
    this.compacting = true;
    this.compactionController = controller;
    // run 内的自动压缩跟随 run 的取消（Esc）
    const abortWithRun = () => controller.abort();
    runSignal?.addEventListener('abort', abortWithRun, { once: true });
    this.handleAgentEvent({ type: 'compaction_start' });
    try {
      const summary = await collectSummary(
        modelApi,
        sideChannel,
        controller.signal,
      );

      this.sessionManager.appendCompaction({
        summary,
        summarizedCount: summarized.length,
        firstRetainedEntryId,
      });
      this.previousSummary = summary;
      const systemPrompt = messages[0];
      const projected: AgentMessage[] = [
        ...(systemPrompt === undefined ? [] : [systemPrompt]),
        makeSummaryMessage(summary),
        ...messages.slice(retainedStart),
      ];
      // state 只接收投影中属于原 state 的部分；当前 run 新增的消息
      // 由 runAgentLoop 在 run 结束时统一 push，提前进 state 会重复
      this.agent.state.messages = projected.filter(
        message => !this.currentRunMessages.has(message),
      );
      this.messagesSinceCompaction = 0;
      this.handleAgentEvent({
        type: 'compaction_end',
        summarizedCount: summarized.length,
      });
      return projected;
    } catch (error: unknown) {
      // 失败/取消：历史不动、不写压缩条目；自动压缩停止重试直到产生新 usage
      if (mode === 'auto') {
        this.autoCompactFailed = true;
      }
      if (controller.signal.aborted) {
        this.sealCompactionNotice('── 上下文压缩已取消 ──');
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        this.sealCompactionNotice(`── 上下文压缩失败：${detail} ──`);
      }
      return undefined;
    } finally {
      runSignal?.removeEventListener('abort', abortWithRun);
      this.compacting = false;
      this.compactionController = undefined;
      this.emit({ type: 'compaction_changed', isCompacting: false });
    }
  }

  private handleAgentEvent(event: AgentEvent) {
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
                error: event.result.error,
                metadata: event.result.metadata,
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
        // 持久化顺序必须是 assistant 在前、它的工具结果在后；反过来
        // resume 之后发给 API 会被拒绝（tool 消息前面没有带 tool_calls 的 assistant）
        if (event.message) {
          const entryId = this.sessionManager.appendMessage(event.message);
          this.entryIds.set(event.message, entryId);
          this.messagesSinceCompaction++;
          this.currentRunMessages.add(event.message);
          // 新一轮真实 usage 落地，自动压缩的失败状态解除
          if (
            event.message.role === 'assistant' &&
            event.message.usage !== undefined
          ) {
            this.autoCompactFailed = false;
          }
        }

        for (const toolResult of event.toolResults) {
          const entryId = this.sessionManager.appendMessage(toolResult);
          this.entryIds.set(toolResult, entryId);
          this.messagesSinceCompaction++;
          this.currentRunMessages.add(toolResult);
        }

        break;
      }

      case 'run_end': {
        if (event.reason === 'error') {
          const detail = event.error?.message ?? '未知错误';
          const label = '出错';
          this.appendText('assistant', `\n\n[${label}] ${detail}`);
        }

        this.finishRun();

        if (event.reason === 'aborted') {
          // 用户主动中断不是错误：单独一条系统提示，不掺进 assistant 文本
          this.appendSystemMessage('[已中断] 用户按 ESC 取消了本次生成');
        }

        break;
      }

      case 'compaction_start': {
        // 消息区插一行「压缩中」，结束时原地更新为结果文案
        const notice: TextChatMessage = {
          id: this.idCounter++,
          role: 'system',
          content: '── 正在压缩上下文 … ──',
        };
        this.compactionNotice = notice;
        this.store.push(notice);
        this.emit({ type: 'message_added', message: notice });
        this.emit({ type: 'compaction_changed', isCompacting: true });
        break;
      }

      case 'compaction_end': {
        // 临时行原地更新为永久标记；恢复时标记由压缩条目重建
        this.sealCompactionNotice(compactionMarkerText(event.summarizedCount));
        break;
      }

      default: {
        // 对 run_start / turn_start，UI 目前没有对应表现
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

  // 系统提示一提交就是终态，和用户消息一样 added 后立刻 sealed
  private appendSystemMessage(content: string): void {
    const message: TextChatMessage = {
      id: this.idCounter++,
      role: 'system',
      content,
    };
    this.store.push(message);
    this.emit({ type: 'message_added', message });
    this.emit({ type: 'message_sealed', message });
  }

  // 把「压缩中」临时行原地更新为最终文案并冻结；行不存在（异常路径）时补发一条
  private sealCompactionNotice(content: string): void {
    const notice = this.compactionNotice;
    this.compactionNotice = undefined;
    if (notice === undefined) {
      this.appendSystemMessage(content);
      return;
    }

    const updated = this.update(notice.id, message => ({
      ...message,
      content,
    }));
    if (updated !== undefined) {
      this.emit({ type: 'message_sealed', message: updated });
    }
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

    // 新段落的第一个增量是纯空白时不建段：Kimi 的思考流会发 "\n\n" 这样的
    // 空白 delta，建出来就是一条看似为空的消息；段已存在后空白照常追加
    // （段内空行是内容的一部分）
    if (delta.trim() === '') {
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

function compactionMarkerText(summarizedCount: number): string {
  return `── 上下文已压缩：前 ${summarizedCount} 条消息已摘要 ──`;
}

// 手动压缩的回退切点：最后一条 user 消息的下标（摘要到它为止，只保留最后一轮）。
// 找不到（或它在可摘要下界上，区间为空调用方处理）时返回 minIndex
function lastUserIndex(
  messages: readonly AgentMessage[],
  minIndex: number,
): number {
  for (let index = messages.length - 1; index > minIndex; index--) {
    if (messages[index]?.role === 'user') {
      return index;
    }
  }
  return minIndex;
}

// 恢复用的消息对：条目 id 随消息走，压缩要引用保留区间第一条的条目 id
type RestoredPair = { id: string; message: AgentMessage };

// 恢复会话文件时把消息序列整理成 API 接受的形态：
// 1. 旧版本把 tool_result 写在 assistant 之前（持久化顺序 bug），挪回正确顺序
// 2. 中断等原因留下的孤儿工具调用（assistant 有 tool_calls 但没有对应
//    tool_result）原样发给 API 也会 400，剥掉；剥完没有内容的空 assistant 一并丢弃
function normalizeRestoredPairs(pairs: RestoredPair[]): RestoredPair[] {
  const reordered: RestoredPair[] = [];
  for (const pair of pairs) {
    const message = pair.message;
    if (message.role === 'assistant') {
      const toolCallIds = new Set(
        message.content.flatMap(block =>
          block.type === 'tool_call' ? [block.id] : [],
        ),
      );
      if (toolCallIds.size > 0) {
        // 末尾紧邻的、属于这条 assistant 的 tool_result 挪到它后面
        let runStart = reordered.length;
        while (runStart > 0) {
          const previous = reordered[runStart - 1]?.message;
          if (
            previous?.role === 'tool_result' &&
            toolCallIds.has(previous.toolCallId)
          ) {
            runStart--;
          } else {
            break;
          }
        }

        if (runStart < reordered.length) {
          const moved = reordered.splice(runStart);
          reordered.push(pair, ...moved);
          continue;
        }
      }
    }

    reordered.push(pair);
  }

  // 每个 tool_call 必须有对应的 tool_result，反之亦然
  const claimedIds = new Set<string>();
  for (const { message } of reordered) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool_call') {
          claimedIds.add(block.id);
        }
      }
    }
  }

  const answeredIds = new Set<string>();
  for (const { message } of reordered) {
    if (message.role === 'tool_result' && claimedIds.has(message.toolCallId)) {
      answeredIds.add(message.toolCallId);
    }
  }

  const result: RestoredPair[] = [];
  for (const pair of reordered) {
    const message = pair.message;
    if (message.role === 'tool_result') {
      if (claimedIds.has(message.toolCallId)) {
        result.push(pair);
      }

      continue;
    }

    if (message.role === 'assistant') {
      const content = message.content.filter(
        block => block.type !== 'tool_call' || answeredIds.has(block.id),
      );
      if (content.length === 0) {
        continue;
      }

      result.push(
        content.length === message.content.length
          ? pair
          : { id: pair.id, message: { ...message, content } },
      );
      continue;
    }

    result.push(pair);
  }

  return result;
}
