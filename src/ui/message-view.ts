import {
  type Component,
  Markdown,
  Marked,
  type Token,
  type Tokens,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type {
  ChatMessage,
  TextChatMessage,
  ToolChatMessage,
} from '../agent/agent-session.ts';
import type { SkillActivation } from '../agent/skills.ts';
import { isSkillReadInput } from '../tools/read.render.ts';
import { skillRenderer } from '../tools/skill.render.ts';
import type {
  ToolRegistry,
  ToolRenderer,
  ToolRenderState,
} from '../tools/types.ts';
import { withCodeBlockStyle } from './code-block.ts';
import { highlightCode } from './highlight.ts';
import { createMarkdownTheme, style } from './theme.ts';
import {
  defaultToolRenderer,
  hasMoreToolBody,
  renderToolBody,
  summariseToolInput,
} from './tool-render-default.ts';

// 消息左侧标记列（标记 + 空格）占的列数
const markerColumns = 2;

// 展开后正文末尾的收起提示（视图自己补的行，不属于任何渲染器）
const collapseHint = '… 点击收起';

// 思考过程默认折叠到这个行数，只给读者一个梗概
const maxThinkingLines = 3;

export type MessageView = Component & {
  update(message: ChatMessage): void;
};

export function createMessageView(
  message: ChatMessage,
  tools: ToolRegistry,
  onRenderRequest: () => void,
): MessageView {
  switch (message.role) {
    case 'system': {
      return new SystemMessageView(message);
    }

    case 'user': {
      const activation = message.skillActivation;
      return activation === undefined
        ? new UserMessageView(message)
        : new SkillActivationMessageView(message, activation, onRenderRequest);
    }

    case 'assistant': {
      return new AssistantMessageView(message.content, onRenderRequest);
    }

    case 'thinking': {
      return new ThinkingMessageView(message);
    }

    case 'tool': {
      // 没有 render、或工具名未知（恢复的旧会话里工具可能已改名）时走兜底渲染器。
      // read SKILL.md 只换展示；输入、输出、截断与执行逻辑完全不变。
      const renderer =
        message.name === 'read' &&
        isSkillReadInput(parseToolInput(message.input))
          ? skillRenderer
          : (tools.get(message.name)?.render ?? defaultToolRenderer);
      return new ToolMessageView(message, renderer, onRenderRequest);
    }

    default: {
      throw new TypeError('未知的消息角色');
    }
  }
}

class SystemMessageView implements MessageView {
  private message: TextChatMessage;

  constructor(message: TextChatMessage) {
    this.message = message;
  }

  update(message: ChatMessage): void {
    if (message.role === 'system') {
      this.message = message;
    }
  }

  invalidate(): void {
    // 没有缓存，不需要清
  }

  render(width: number): string[] {
    return wrapTextWithAnsi(this.message.content, Math.max(1, width)).map(
      line => style.system(line),
    );
  }
}

class UserMessageView implements MessageView {
  private message: TextChatMessage;

  constructor(message: TextChatMessage) {
    this.message = message;
  }

  update(message: ChatMessage): void {
    if (message.role === 'user') {
      this.message = message;
    }
  }

  invalidate(): void {
    // 没有缓存，不需要清
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - markerColumns);
    const lines = wrapTextWithAnsi(this.message.content, inner);
    return lines.map((line, index) => {
      if (index === 0) {
        return `${style.bubble('●')} ${line}`;
      }

      return line === '' ? '' : `  ${line}`;
    });
  }
}

// 手动激活仍是一条 user Protocol message；视图把结构化内容映射成 Skill 加载记录，
// 额外描述保留普通用户消息的样式。会话恢复走同一条纯内容解析路径，无需重读文件。
export class SkillActivationMessageView implements MessageView {
  private readonly skillView: ToolMessageView;
  private readonly descriptionView: UserMessageView | undefined;
  private skillRows = 0;

  constructor(
    message: TextChatMessage,
    activation: SkillActivation,
    onRenderRequest: () => void,
  ) {
    const toolMessage: ToolChatMessage = {
      id: message.id,
      role: 'tool',
      toolCallId: `manual-skill-${message.id}`,
      name: 'skill',
      input: JSON.stringify({
        filePath: activation.location,
        skillName: activation.name,
      }),
      output: activation.body,
      status: 'done',
      success: true,
    };
    this.skillView = new ToolMessageView(
      toolMessage,
      skillRenderer,
      onRenderRequest,
    );
    this.descriptionView =
      activation.additionalDescription.trim() === ''
        ? undefined
        : new UserMessageView({
            id: message.id,
            role: 'user',
            content: activation.additionalDescription,
          });
  }

  update(_message: ChatMessage): void {
    // 用户消息提交即冻结，没有需要同步到这条视图的流式更新。
  }

  invalidate(): void {
    this.skillView.invalidate();
    this.descriptionView?.invalidate();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y >= this.skillRows) {
      return undefined;
    }
    return this.skillView.handleMouse(event);
  }

  render(width: number): string[] {
    const skillLines = this.skillView.render(width);
    this.skillRows = skillLines.length;
    return [...skillLines, ...(this.descriptionView?.render(width) ?? [])];
  }
}

export class AssistantMessageView implements MessageView {
  private readonly markdown: Markdown;
  private text: string;
  private sealed = false;
  private readonly onHighlightReady: () => void;

  constructor(content: string, onHighlightReady: () => void) {
    this.text = content;
    this.onHighlightReady = onHighlightReady;
    this.markdown = withCodeBlockStyle(
      new Markdown(content, 0, 0, createMarkdownTheme()),
      () => {
        this.markdown.invalidate();
        this.onHighlightReady();
      },
    );
  }

  update(message: ChatMessage): void {
    if (message.role !== 'assistant' || this.sealed) {
      return;
    }

    this.text = message.content;
    this.markdown.setText(message.content);
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  // 冻结前调用：把正文里所有代码块的语法高亮算完，之后这条消息不再修改
  async seal(): Promise<void> {
    if (this.sealed) {
      return;
    }

    this.sealed = true;
    const codes = collectCodeTokens(new Marked().lexer(this.text));
    await Promise.all(
      codes.map(async token => highlightCode(token.text, token.lang)),
    );
    this.markdown.invalidate();
    this.onHighlightReady();
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - markerColumns);
    const lines = this.markdown.render(inner);
    return lines.map((line, index) => {
      // Markdown 会把每行补空格到整宽；去掉尾部填充，复制时干净
      const content = line.trimEnd();
      if (index === 0) {
        return `${style.assistantMark('◎')} ${content}`.trimEnd();
      }

      return content === '' ? '' : `  ${content}`;
    });
  }
}

// 思考过程：暗色渲染，默认折叠成前几行，不和正文抢注意力
class ThinkingMessageView implements MessageView {
  private message: TextChatMessage;

  constructor(message: TextChatMessage) {
    this.message = message;
  }

  update(message: ChatMessage): void {
    if (message.role === 'thinking') {
      this.message = message;
    }
  }

  invalidate(): void {
    // 没有缓存，不需要清
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - markerColumns);
    const wrapped = wrapTextWithAnsi(this.message.content, inner);
    const shown = wrapped.slice(0, maxThinkingLines);
    const hidden = wrapped.length - shown.length;

    const lines = shown.map((line, index) =>
      index === 0
        ? `${style.dim('◎')} ${style.dim(line)}`.trimEnd()
        : `  ${style.dim(line)}`.trimEnd(),
    );
    if (hidden > 0) {
      lines.push(`  ${style.dim(`… 还有 ${hidden} 行思考`)}`);
    }

    return lines;
  }
}

export class ToolMessageView implements MessageView {
  private message: ToolChatMessage;
  private readonly renderer: ToolRenderer;
  private readonly onRenderRequest: () => void;
  // 展开状态跨 update 保留：同一条消息从 running 变 done，不该把用户展开的正文又折回去
  private expanded: boolean;
  // 折叠时正文最后一行是「… 还有 N 行，点击展开」提示，点它也能展开；没有提示时为 undefined
  private collapsedTipRow: number | undefined;
  // 展开时正文末尾是视图补的「… 点击收起」行，点它收起；没有这行时为 undefined
  private expandedTipRow: number | undefined;

  constructor(
    message: ToolChatMessage,
    renderer: ToolRenderer,
    onRenderRequest: () => void,
  ) {
    this.message = message;
    this.renderer = renderer;
    this.onRenderRequest = onRenderRequest;
    this.expanded = false;
    this.collapsedTipRow = undefined;
    this.expandedTipRow = undefined;
  }

  update(message: ChatMessage): void {
    if (message.role === 'tool') {
      this.message = message;
    }
  }

  invalidate(): void {
    // 没有缓存，不需要清
  }

  // 头部行、折叠提示行、收起行都能点。
  // 全屏 TUI 先派发 press、再在 release 时补发 click：press 必须返回 handled，
  // 否则不会被记为点击目标，click 永远不会发到组件上。真正的切换留给 click，
  // 这样按住后拖到别处松开不会误触
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left' || !this.isToggleRow(event.y)) {
      return undefined;
    }

    if (event.type === 'press') {
      return { handled: true };
    }

    if (event.type !== 'click') {
      return undefined;
    }

    this.toggleExpanded();
    return { handled: true, render: true };
  }

  private isToggleRow(y: number): boolean {
    return (
      y === 0 ||
      (this.collapsedTipRow !== undefined && y === this.collapsedTipRow) ||
      (this.expandedTipRow !== undefined && y === this.expandedTipRow)
    );
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.invalidate();
    this.onRenderRequest();
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - markerColumns);
    const state = this.renderState();
    // 展开/收起入口交给渲染器判断：正文行数会被折叠预览里的提示行带偏
    const expandable = (this.renderer.hasMoreBody ?? hasMoreToolBody)(state);

    const body = this.bodyLines(state, inner, this.expanded);
    // 收起行由视图补在正文末尾，渲染器不知道它的存在；缩进和正文行一致
    const rows =
      this.expanded && expandable
        ? [...body, `${' '.repeat(markerColumns)}${style.dim(collapseHint)}`]
        : body;
    this.collapsedTipRow =
      !this.expanded && expandable ? body.length : undefined;
    this.expandedTipRow = this.expanded && expandable ? rows.length : undefined;

    return [this.headerLine(state, inner, expandable), ...rows];
  }

  // 头部行：标记 + 工具名 + 参数摘要 + 折叠指示符。展开的入口就是这一行
  private headerLine(
    state: ToolRenderState,
    inner: number,
    expandable: boolean,
  ): string {
    const failed = state.status === 'done' && !state.success;
    const mark = style.toolMark(failed ? '✗' : '⚙', failed);
    const displayName =
      this.renderer.displayName?.(state.input) ?? this.message.name;
    const name = style.toolName(displayName, failed);
    const running =
      state.status === 'running' ? style.running('（执行中…）') : '';
    const summary =
      this.renderer.summarise?.(state.input) ?? summariseToolInput(state.input);
    const summaryText = summary === '' ? '' : ` ${style.dim(`→ ${summary}`)}`;
    // 指示符挂在行尾，先给摘要留出它的宽度再截断，否则超长摘要会把它切掉
    const indicator = expandable
      ? ` ${style.dim(this.expanded ? '▾' : '▸')}`
      : '';

    const head = `${mark} ${name}${running}${summaryText}`;
    return (
      truncateToWidth(head, Math.max(1, inner - visibleWidth(indicator))) +
      indicator
    );
  }

  // 正文行：渲染器自己着色、自己收窄到 inner，这里只补左侧标记列的缩进
  private bodyLines(
    state: ToolRenderState,
    inner: number,
    expanded: boolean,
  ): string[] {
    if (state.status !== 'done') {
      return [];
    }

    const renderBody = this.renderer.renderBody ?? renderToolBody;
    return renderBody(state, { width: inner, expanded }).map(line =>
      line === ''
        ? ''
        : `${' '.repeat(markerColumns)}${truncateToWidth(line, inner)}`,
    );
  }

  private renderState(): ToolRenderState {
    const { message } = this;
    const input = parseToolInput(message.input);
    if (message.status === 'running') {
      return { status: 'running', input };
    }

    return {
      status: 'done',
      input,
      output: message.output,
      error: message.error,
      success: message.success,
      metadata: message.metadata,
    };
  }
}

// 工具参数以 JSON 字符串保存；解析失败（历史会话里的异常数据）时原样交给渲染器
function parseToolInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

// Settle 时把 markdown 里所有层级的 code token 找出来（引用块、列表里也可能有）
function collectCodeTokens(tokens: Token[]): Tokens.Code[] {
  const found: Tokens.Code[] = [];
  for (const token of tokens) {
    if (token.type === 'code') {
      found.push(token as Tokens.Code);
      continue;
    }

    const children = (token as { tokens?: Token[] }).tokens;
    if (children !== undefined) {
      found.push(...collectCodeTokens(children));
    }
  }

  return found;
}
