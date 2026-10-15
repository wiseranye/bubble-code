import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

// 块的折叠预算：超过这个行数就折成一行提示；折叠预览最多保留这么多行
export const collapsedBodyLines = 8;

// 展开后的正文行数超过折叠预算，说明预览之外还有内容。
// 折叠预览最多保留 collapsedBodyLines 行，所以只要展开的行数更多就一定藏了内容
export function previewHidesContent(expandedRows: number): boolean {
  return expandedRows > collapsedBodyLines;
}
// 行号栏（符号 + 行号）与内容之间的间隔
const gutterGap = 4;

// GitHub 深色主题的块配色：所有行同用一层深绿底色，靠文字颜色区分行型。
// 写成函数是为了让 chalk 的色深在调用时才决定，测试里改 chalk.level 也能生效
// （和 src/ui/theme.ts 的 style 一样）
export const blockBackground = (text: string): string =>
  chalk.bgHex('#12261e')(text);
export const addColor = (text: string): string => chalk.hex('#3fb950')(text);
export const delColor = (text: string): string => chalk.hex('#f85149')(text);
export const contextColor = (text: string): string =>
  chalk.hex('#8b949e')(text);
// 行号栏和省略号用的暗灰：比 context 正文再暗一档
export const mutedColor = (text: string): string => chalk.hex('#6e7681')(text);

export type Style = (text: string) => string;

// 「符号 + 行号」列宽度：符号 1 列 + 最大行号的位数
export function gutterColumnWidth(maxNumber: number): number {
  return 1 + String(maxNumber).length;
}

// 行号栏：符号贴左、行号在剩余宽度里右对齐，后面留固定间隔
export function gutterPrefix(
  sign: string,
  number: number,
  columnWidth: number,
): string {
  return `${sign}${String(number).padStart(columnWidth - 1)}${' '.repeat(gutterGap)}`;
}

// 行号栏占的空白：没有行号的行（比如省略行）用它保持内容对齐
export function gutterIndent(columnWidth: number): string {
  if (columnWidth === 0) {
    return '';
  }

  return ' '.repeat(columnWidth + gutterGap);
}

// 块里的一行：行号栏 + 内容，整行铺底色并补满 ctx.width
export function blockRow(row: {
  gutter: string;
  content: string;
  width: number;
  contentColor: Style;
  gutterColor: Style;
}): string {
  const gutterWidth = visibleWidth(row.gutter);
  const content = truncateToWidth(
    row.content,
    Math.max(1, row.width - gutterWidth),
  );
  const padding = ' '.repeat(
    Math.max(0, row.width - gutterWidth - visibleWidth(content)),
  );

  return blockBackground(
    `${row.gutterColor(row.gutter)}${row.contentColor(content)}${padding}`,
  );
}

// 正文片段：lines 是正文行，block 表示这是不是一个块（块前面留一个空行和标题分开）
export type BodyPart = {
  lines: string[];
  block: boolean;
};

// 正文收尾：先按折叠预算截断，再给块补内边距和前面的空行，最后逐行收窄到 ctx.width
export function assembleBody(
  part: BodyPart,
  ctx: { width: number; expanded: boolean },
): string[] {
  const capped = capLines(part.lines, ctx.expanded);
  const lines: string[] = [];
  if (part.block) {
    // 空行是块和标题之间的外边距，两行纯底色是块的内边距；提示行留在块外面
    lines.push(
      '',
      paddingRow(ctx.width),
      ...capped.lines,
      paddingRow(ctx.width),
    );
  } else {
    lines.push(...capped.lines);
  }

  if (capped.tip !== undefined) {
    lines.push(capped.tip);
  }

  return lines.map(line => truncateToWidth(line, ctx.width));
}

type CappedLines = {
  lines: string[];
  // 被折叠掉的行折成的一行提示；没有截断时为 undefined
  tip?: string;
};

// 折叠时只留头部若干行，其余折成一行提示
export function capLines(lines: string[], expanded: boolean): CappedLines {
  if (expanded || lines.length <= collapsedBodyLines) {
    return { lines };
  }

  return {
    lines: lines.slice(0, collapsedBodyLines),
    tip: chalk.dim(`… 还有 ${lines.length - collapsedBodyLines} 行，点击展开`),
  };
}

// 块的内边距：一整行够宽的底色，没有行号也没有文字
function paddingRow(width: number): string {
  return blockBackground(' '.repeat(width));
}

// 失败正文：错误在前、输出在后，都是纯文本
export function failureLines(
  error: string | undefined,
  output: string,
): string[] {
  return [
    ...textLines(error ?? '').map(line => chalk.red(line)),
    ...textLines(output).map(line => chalk.dim(line)),
  ];
}

export function textLines(text: string): string[] {
  const body = text.replace(/\n+$/, '');
  return body === '' ? [] : body.split('\n');
}
