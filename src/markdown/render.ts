import {Lexer, type Token, type Tokens} from 'marked';
import {stringWidth, tailRows, wrappedHeight} from '../utils/width.js';

// 内联样式，字段和 Ink <Text> 的 props 一一对应
export type Span = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  backgroundColor?: string;
};

// 一行普通文本；spans 里的换行已经拆成多行
export type TextLine = {
  kind: 'text';
  spans: Span[];
};

// 代码块整体作为一个条目：按行渲染、不参与换行，超宽直接截断
export type CodeLine = {
  kind: 'code';
  // 纯文本行，还没有高亮结果时用它渲染
  plain: string[];
  // shiki 渲染好的 ANSI 行，由 marked-shiki 注入
  ansi: string[] | undefined;
  // 每行前缀（缩进 + 代码块左侧竖线）
  prefix: string;
};

export type MarkdownLine = TextLine | CodeLine;

export type RenderOptions = {
  cols: number;
  // 只渲染末尾这么多行（实时区域超出屏幕时用），前面的内容加一行省略提示
  maxRows?: number | undefined;
};

// marked-shiki 注入的高亮内容用这个字符打头，和模型自己写的 HTML 区分开。
// 模型输出在词法分析前已经被 sanitize 清掉了控制字符，所以它不可能带这个前缀。
export const renderedMarker = '\u0001';

// 代码块每行开头的暗色竖线，语言高亮缺失时也能看出边界
const codeBar = '\u001B[2m▎ \u001B[0m';

// --------------- 入口 --------------- //

// 同步渲染：不做语法高亮，用于流式过程中的每帧重绘和高度计算
export function renderMarkdown(
  content: string,
  options: RenderOptions,
): MarkdownLine[] {
  return renderTokens(Lexer.lex(sanitize(content)), options);
}

// 渲染已经词法分析过的 token（marked-shiki 会把高亮结果写回 token）
export function renderTokens(
  tokens: Token[],
  options: RenderOptions,
): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  renderBlocks(tokens, lines, noPrefix, options);
  return clipLines(trimBlankEdges(lines), options.cols, options.maxRows);
}

// 消息占多少行，必须和渲染结果一致，否则实时区域会被裁错
export function markdownHeight(content: string, cols: number): number {
  return Math.max(1, countRows(renderMarkdown(content, {cols}), cols));
}

export function lineHeight(line: MarkdownLine, cols: number): number {
  return line.kind === 'code'
    ? codeLineCount(line)
    : wrappedHeight(plainText(line.spans), cols);
}

function countRows(lines: MarkdownLine[], cols: number): number {
  let rows = 0;
  for (const line of lines) {
    rows += lineHeight(line, cols);
  }

  return rows;
}

// 只保留末尾能放进 maxRows 行的内容。
// 实时区域在终端里只是视口：超过屏幕高度会让 Ink 清屏重写（画面重复），
// 而完整内容会在消息定稿时通过 <Static> 写进 scrollback。
export function clipLines(
  lines: MarkdownLine[],
  cols: number,
  maxRows: number | undefined,
): MarkdownLine[] {
  if (maxRows === undefined || countRows(lines, cols) <= maxRows) {
    return lines;
  }

  const indicator: TextLine = {
    kind: 'text',
    spans: [{text: '… 以上内容已滚出屏幕', dim: true}],
  };
  const budget = maxRows - lineHeight(indicator, cols);
  if (budget <= 0) {
    return [indicator];
  }

  let used = 0;
  let start = lines.length;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }

    const height = lineHeight(line, cols);
    if (used + height > budget) {
      // 这一行本身就有多行高，只能留它的末尾
      const tail = tailOfLine(line, cols, budget - used);
      return tail === undefined
        ? [indicator, ...lines.slice(index + 1)]
        : [indicator, tail, ...lines.slice(index + 1)];
    }

    used += height;
    start = index;
  }

  return [indicator, ...lines.slice(start)];
}

function tailOfLine(
  line: MarkdownLine,
  cols: number,
  rows: number,
): MarkdownLine | undefined {
  if (rows <= 0) {
    return undefined;
  }

  if (line.kind === 'code') {
    const ansi = line.ansi?.slice(-rows);
    return {
      ...line,
      plain: line.plain.slice(-rows),
      ansi: ansi === undefined ? undefined : ansi,
    };
  }

  // 样式在这个边界行上会丢，但它已经被裁到屏幕外，只求行数对得上
  return {
    kind: 'text',
    spans: [{text: tailRows(plainText(line.spans), cols, rows)}],
  };
}

function codeLineCount(line: CodeLine): number {
  return Math.max(1, (line.ansi ?? line.plain).length);
}

function plainText(spans: Span[]): string {
  return spans.map(span => span.text).join('');
}

// --------------- 块级渲染 --------------- //

type Prefix = {
  // 引用块的竖线这类装饰，原样出现在每行开头
  decoration: string;
  // 列表缩进，第一行的这部分会被项目符号替换
  indent: string;
};

const noPrefix: Prefix = {decoration: '', indent: ''};

function renderBlocks(
  tokens: Token[],
  out: MarkdownLine[],
  prefix: Prefix,
  options: RenderOptions,
): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'space': {
        pushBlank(out);
        break;
      }

      case 'heading': {
        pushText(out, prefix, headingSpans(token as Tokens.Heading));
        break;
      }

      case 'paragraph':
      case 'text': {
        for (const spans of inlineToLines(inlineTokens(token))) {
          pushText(out, prefix, spans);
        }

        break;
      }

      case 'code': {
        pushCode(out, token as Tokens.Code, prefix);
        break;
      }

      case 'blockquote': {
        renderBlocks(
          childTokens(token),
          out,
          {decoration: `${prefix.decoration}│ `, indent: prefix.indent},
          options,
        );
        break;
      }

      case 'list': {
        renderList(token as Tokens.List, out, prefix, options);
        break;
      }

      case 'table': {
        renderTable(token as Tokens.Table, out, prefix, options);
        break;
      }

      case 'hr': {
        pushText(out, prefix, [{text: '─'.repeat(32), dim: true}]);
        break;
      }

      case 'html': {
        pushHtml(out, token.text as string, prefix);
        break;
      }

      // 链接定义（def）、任务勾选框（checkbox）等在终端里没有单独的表现
      default: {
        break;
      }
    }
  }
}

function pushText(out: MarkdownLine[], prefix: Prefix, spans: Span[]): void {
  out.push({kind: 'text', spans: [...prefixSpans(prefix), ...spans]});
}

// 空行只留一行，且不放在开头
function pushBlank(out: MarkdownLine[]): void {
  const last = out[out.length - 1];
  if (last === undefined) {
    return;
  }

  if (last.kind === 'text' && last.spans.length === 0) {
    return;
  }

  out.push({kind: 'text', spans: []});
}

function prefixSpans(prefix: Prefix): Span[] {
  const spans: Span[] = [];
  if (prefix.decoration !== '') {
    spans.push({text: prefix.decoration, dim: true});
  }

  if (prefix.indent !== '') {
    spans.push({text: prefix.indent});
  }

  return spans;
}

function trimBlankEdges(lines: MarkdownLine[]): MarkdownLine[] {
  let start = 0;
  let end = lines.length;

  while (start < end && isBlank(lines[start])) {
    start++;
  }

  while (end > start && isBlank(lines[end - 1])) {
    end--;
  }

  return lines.slice(start, end);
}

function isBlank(line: MarkdownLine | undefined): boolean {
  return line !== undefined && line.kind === 'text' && line.spans.length === 0;
}

// --------------- 标题 / 代码 / 列表 / 表格 --------------- //

function headingSpans(token: Tokens.Heading): Span[] {
  const base: Omit<Span, 'text'> =
    token.depth <= 2 ? {bold: true, color: 'cyanBright'} : {bold: true};
  return inlineToLines(token.tokens, base).flat();
}

// 没有高亮结果的代码块：纯文本 + 左侧竖线
function pushCode(
  out: MarkdownLine[],
  token: Tokens.Code,
  prefix: Prefix,
): void {
  const code = token.text.replace(/\n+$/, '');
  out.push({
    kind: 'code',
    plain: code.split('\n'),
    ansi: undefined,
    prefix: codePrefix(prefix),
  });
}

// marked-shiki 已经渲染好的代码块（ANSI 文本）
function pushRendered(out: MarkdownLine[], text: string, prefix: Prefix): void {
  const ansi = text.replace(/\n+$/, '').split('\n');
  out.push({
    kind: 'code',
    plain: ansi.map(line => stripAnsi(line)),
    ansi,
    prefix: codePrefix(prefix),
  });
}

function pushHtml(out: MarkdownLine[], text: string, prefix: Prefix): void {
  if (text.startsWith(renderedMarker)) {
    pushRendered(out, text.slice(renderedMarker.length), prefix);
    return;
  }

  // HTML 标签在终端里没有意义，只保留文字部分
  const plain = text.replace(/<[^>]*>/g, '').trim();
  if (plain === '') {
    return;
  }

  for (const line of plain.split('\n')) {
    pushText(out, prefix, [{text: line, dim: true}]);
  }
}

function codePrefix(prefix: Prefix): string {
  return `${prefix.decoration}${prefix.indent}${codeBar}`;
}

function renderList(
  token: Tokens.List,
  out: MarkdownLine[],
  prefix: Prefix,
  options: RenderOptions,
): void {
  const start = typeof token.start === 'number' ? token.start : 1;

  token.items.forEach((item, index) => {
    const marker = listMarker(token.ordered, start + index, item);
    // 内容按「项目符号等宽的缩进」渲染，最后再把第一行的缩进换成符号
    const continuation: Prefix = {
      decoration: prefix.decoration,
      indent: prefix.indent + ' '.repeat(stringWidth(marker)),
    };

    const mark = out.length;
    renderBlocks(
      item.tokens.length > 0 ? item.tokens : [textToken(item.text)],
      out,
      continuation,
      options,
    );

    const first = out[mark];
    if (first === undefined) {
      pushText(out, {...continuation, indent: prefix.indent + marker}, []);
    } else if (first.kind === 'code') {
      // 代码块开头顶不下项目符号，符号单独占一行
      out.splice(mark, 0, {
        kind: 'text',
        spans: prefixSpans({...continuation, indent: prefix.indent + marker}),
      });
    } else {
      out[mark] = {
        kind: 'text',
        spans: replaceIndent(
          first.spans,
          continuation.indent,
          prefix.indent + marker,
        ),
      };
    }
  });
}

function listMarker(
  ordered: boolean,
  position: number,
  item: Tokens.ListItem,
): string {
  if (ordered) {
    return `${position}. `;
  }

  if (item.task) {
    return item.checked === true ? '☑ ' : '☐ ';
  }

  return '• ';
}

// 把第一行开头的缩进换成项目符号（宽度相同，后面的行能对齐）
function replaceIndent(spans: Span[], from: string, to: string): Span[] {
  if (from === '') {
    return [{text: to}, ...spans];
  }

  const index = spans.findIndex(span => span.text === from);
  if (index === -1) {
    return [{text: to}, ...spans];
  }

  return spans.map((span, position) =>
    position === index ? {...span, text: to} : span,
  );
}

function renderTable(
  token: Tokens.Table,
  out: MarkdownLine[],
  prefix: Prefix,
  options: RenderOptions,
): void {
  const columns = token.header.length;
  if (columns === 0) {
    return;
  }

  const rows = [token.header, ...token.rows];
  const cells = rows.map(row =>
    Array.from({length: columns}, (_, column) => {
      const cell = row[column];
      return cell === undefined ? [] : inlineToLines(cell.tokens)[0] ?? [];
    }),
  );

  const widths = Array.from({length: columns}, (_, column) =>
    Math.max(0, ...cells.map(row => stringWidth(plainText(row[column] ?? [])))),
  );

  const available = Math.max(
    1,
    options.cols - stringWidth(prefix.decoration) - stringWidth(prefix.indent),
  );
  const tableWidth =
    widths.reduce((sum, width) => sum + width, 0) + (columns - 1) * 3;

  // 表格放不下就退化成一行一条，交给终端换行，至少不破坏排版
  if (tableWidth > available) {
    for (const [index, row] of cells.entries()) {
      const spans: Span[] = [];
      for (const [column, cell] of row.entries()) {
        if (column > 0) {
          spans.push({text: ' · ', dim: true});
        }

        spans.push(...withHeadingStyle(cell, index === 0));
      }

      pushText(out, prefix, spans);
    }

    return;
  }

  for (const [index, row] of cells.entries()) {
    const spans: Span[] = [];
    for (let column = 0; column < columns; column++) {
      if (column > 0) {
        spans.push({text: ' │ ', dim: true});
      }

      const cell = withHeadingStyle(row[column] ?? [], index === 0);
      const pad = Math.max(
        0,
        (widths[column] ?? 0) - stringWidth(plainText(cell)),
      );
      const align = token.align[column] ?? null;
      const leading =
        align === 'right' ? pad : align === 'center' ? Math.floor(pad / 2) : 0;

      if (leading > 0) {
        spans.push({text: ' '.repeat(leading)});
      }

      spans.push(...cell);

      const trailing = pad - leading;
      if (trailing > 0) {
        spans.push({text: ' '.repeat(trailing)});
      }
    }

    pushText(out, prefix, spans);
  }
}

function withHeadingStyle(spans: Span[], heading: boolean): Span[] {
  return heading ? spans.map(span => ({...span, bold: true})) : spans;
}

// --------------- 内联渲染 --------------- //

type Style = Omit<Span, 'text'>;

function inlineToLines(tokens: Token[], base: Style = {}): Span[][] {
  const lines: Span[][] = [[]];
  collectInline(tokens, base, lines);
  return lines;
}

function collectInline(tokens: Token[], style: Style, lines: Span[][]): void {
  const current = (): Span[] => {
    let line = lines[lines.length - 1];
    if (line === undefined) {
      line = [];
      lines.push(line);
    }

    return line;
  };

  // 软换行（源码里段落内的换行）也要拆成独立行，
  // 否则第二行会丢掉引用块前缀和列表缩进
  const push = (span: Span) => {
    span.text.split('\n').forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }

      if (part !== '') {
        current().push({...span, text: part});
      }
    });
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'strong': {
        collectInline(inlineTokens(token), {...style, bold: true}, lines);
        break;
      }

      case 'em': {
        collectInline(inlineTokens(token), {...style, italic: true}, lines);
        break;
      }

      case 'del': {
        collectInline(
          inlineTokens(token),
          {...style, strikethrough: true},
          lines,
        );
        break;
      }

      case 'codespan': {
        push({...style, text: token.text, color: 'cyan'});
        break;
      }

      case 'br': {
        lines.push([]);
        break;
      }

      case 'escape': {
        push({...style, text: token.text});
        break;
      }

      case 'html': {
        const text = token.text.replace(/<[^>]*>/g, '');
        if (text !== '') {
          push({...style, text, dim: true});
        }

        break;
      }

      case 'link': {
        collectInline(
          inlineTokens(token),
          {...style, underline: true, color: style.color ?? 'blue'},
          lines,
        );
        // 链接文字和地址不一样时，把地址附在后面
        if (token.href !== '' && token.href !== token.text) {
          push({...style, text: ` (${token.href})`, dim: true});
        }

        break;
      }

      case 'image': {
        push({...style, text: `[图片: ${token.text}]`, dim: true});
        if (token.href !== '') {
          push({...style, text: ` (${token.href})`, dim: true});
        }

        break;
      }

      case 'text': {
        if (token.tokens === undefined || token.tokens.length === 0) {
          push({...style, text: token.text});
        } else {
          collectInline(token.tokens, style, lines);
        }

        break;
      }

      default: {
        break;
      }
    }
  }
}

// 块级 Text token 的内联子节点；没有子节点就用它自己的文本
function inlineTokens(token: Token): Token[] {
  const tokens = childTokens(token);
  if (tokens.length > 0) {
    return tokens;
  }

  const {text} = token as {text?: unknown};
  return typeof text === 'string' ? [textToken(text)] : [];
}

function textToken(text: string): Token {
  return {type: 'text', raw: text, text};
}

// marked 的 Token 联合带一个 Generic 兜底类型，按 type 收窄不掉它，只能显式取
function childTokens(token: Token): Token[] {
  return (token as {tokens?: Token[]}).tokens ?? [];
}

// --------------- 文本清洗 --------------- //

// 模型输出里可能混进终端控制序列；先清掉，只留换行和制表符
const ansiPattern =
  /[\u001B\u009B][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const controlCharacters = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function sanitize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(ansiPattern, '')
    .replace(controlCharacters, '');
}

export function stripAnsi(text: string): string {
  return text.replace(ansiPattern, '');
}
