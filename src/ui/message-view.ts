import {
  type Component,
  Marked,
  Markdown,
  type Token,
  type Tokens,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import {
  type ChatMessage,
  type TextChatMessage,
  type ToolChatMessage,
} from '../chat-session.js';
import {highlightCode} from '../markdown/highlight.js';
import {createMarkdownTheme, style} from './theme.js';

// 消息左侧标记列（标记 + 空格）占的列数
const markerColumns = 2;

// 工具输出超过这个行数就折叠，避免一条命令刷满整个消息区
const maxToolOutputLines = 8;

export type MessageView = Component & {
  update(message: ChatMessage): void;
};

export function createMessageView(
  message: ChatMessage,
  onHighlightReady: () => void,
): MessageView {
  switch (message.role) {
    case 'system': {
      return new SystemMessageView(message);
    }

    case 'user': {
      return new UserMessageView(message);
    }

    case 'assistant': {
      return new AssistantMessageView(message.content, onHighlightReady);
    }

    case 'tool': {
      return new ToolMessageView(message);
    }

    default: {
      throw new TypeError('未知的消息角色');
    }
  }
}

class SystemMessageView implements MessageView {
  constructor(private message: TextChatMessage) {}

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
  constructor(private message: TextChatMessage) {}

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
        return `${style.userMark('❯')} ${line}`;
      }

      return line === '' ? '' : `  ${line}`;
    });
  }
}

export class AssistantMessageView implements MessageView {
  private readonly markdown: Markdown;
  private text: string;
  private sealed = false;

  constructor(content: string, private readonly onHighlightReady: () => void) {
    this.text = content;
    this.markdown = new Markdown(
      content,
      0,
      0,
      createMarkdownTheme(() => {
        this.markdown.invalidate();
        this.onHighlightReady();
      }),
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

  // 冻结前调用：把正文里所有代码块的语法高亮算完，
  // 之后这条消息不再修改（pi-tui 主屏对已滚出视口的行改动会整卷重打）
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
    return lines.map((line, index) =>
      index === 0 ? `${style.assistantMark('✦')} ${line}` : `  ${line}`,
    );
  }
}

class ToolMessageView implements MessageView {
  constructor(private message: ToolChatMessage) {}

  update(message: ChatMessage): void {
    if (message.role === 'tool') {
      this.message = message;
    }
  }

  invalidate(): void {
    // 没有缓存，不需要清
  }

  render(width: number): string[] {
    const {message} = this;
    const running = message.status === 'running';
    const failed = !running && !message.success;

    // 执行中/成功 → 黄色齿轮；失败 → 红色叉
    const lines = [
      `${style.toolMark(failed ? '✗' : '⚙', failed)} ${style.toolName(
        message.name,
        failed,
      )}${running ? style.running('（执行中…）') : ''}`,
    ];

    const inner = Math.max(1, width - markerColumns);
    const input = summariseInput(message.input);
    if (input !== '') {
      for (const line of wrapTextWithAnsi(`→ ${input}`, inner)) {
        lines.push(`  ${style.dim(line)}`);
      }
    }

    const {lines: outputLines, hidden} = toolOutputLines(
      message.output,
      maxToolOutputLines,
    );
    for (const line of outputLines) {
      for (const wrapped of wrapTextWithAnsi(line === '' ? ' ' : line, inner)) {
        lines.push(`  ${style.dim(wrapped)}`);
      }
    }

    if (hidden > 0) {
      lines.push(`  ${style.dim(`… 还有 ${hidden} 行输出`)}`);
    }

    return lines;
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

    const children = (token as {tokens?: Token[]}).tokens;
    if (children !== undefined) {
      found.push(...collectCodeTokens(children));
    }
  }

  return found;
}

// 参数压成一行展示：只有一个字段（比如 bash 的 command）时只显示值，
// 其余情况原样显示 JSON
function summariseInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    return '';
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const entries = Object.entries(parsed);
      const single = entries.length === 1 ? entries[0] : undefined;
      if (single) {
        const [, value] = single;
        if (typeof value === 'string') {
          return toSingleLine(value);
        }
      }
    }
  } catch {
    // 参数不是合法 JSON，原样显示
  }

  return toSingleLine(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 多行参数（比如写文件的 content）只显示第一行，避免撑爆消息区
function toSingleLine(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  return rest.length > 0 ? `${first} …` : first;
}

type OutputLines = {
  lines: string[];
  hidden: number;
};

function toolOutputLines(output: string, limit: number): OutputLines {
  if (output === '' || limit <= 0) {
    return {lines: [], hidden: 0};
  }

  const all = output.replace(/\n+$/, '').split('\n');
  return {
    lines: all.slice(0, limit),
    hidden: Math.max(0, all.length - limit),
  };
}
