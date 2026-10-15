import chalk from 'chalk';
import * as z from 'zod';
import {
  addColor,
  assembleBody,
  type BodyPart,
  blockRow,
  collapsedBodyLines,
  contextColor,
  delColor,
  failureLines,
  gutterColumnWidth,
  gutterIndent,
  gutterPrefix,
  mutedColor,
  previewHidesContent,
  textLines,
} from './block.render.ts';
import {
  computeLineDiff,
  type DiffEntry,
  type DiffLine,
  normalizeToLF,
} from './edit-diff.ts';
import { editInputSchema } from './edit-input.ts';
import { summariseUnknownInput } from './summarise-input.ts';
import type { ToolRenderer, ToolRenderState } from './types.ts';

// edit 成功时写进 metadata.diff 的数据
const diffMetadataSchema = z.object({
  filePath: z.string(),
  oldText: z.string(),
  newText: z.string(),
  startLine: z.number(),
});

interface DiffData {
  oldText: string;
  newText: string;
  // 缺失时不画行号栏（老会话的 metadata 里没有 diff）
  startLine?: number;
}

type DoneState = {
  input: unknown;
  output: string;
  error?: string;
  success: boolean;
  metadata?: Record<string, unknown>;
};

export const editRenderer: ToolRenderer = {
  summarise,
  renderBody,
  hasMoreBody,
};

function summarise(input: unknown): string {
  const parsed = editInputSchema.safeParse(input);
  if (!parsed.success) {
    return summariseUnknownInput(input);
  }

  return parsed.data.filePath;
}

function renderBody(
  state: ToolRenderState,
  ctx: { width: number; expanded: boolean },
): string[] {
  if (state.status !== 'done') {
    return [];
  }

  return assembleBody(bodyContent(state, ctx), ctx);
}

// 展开能看到更多行：整段 diff 超过折叠预算
function hasMoreBody(state: ToolRenderState): boolean {
  if (state.status !== 'done' || !state.success) {
    return false;
  }

  const diff = resolveDiff(state);
  if (diff === undefined) {
    // 兜底正文是工具输出，同样按预算折叠
    return previewHidesContent(textLines(state.output).length);
  }

  return previewHidesContent(diffEntries(diff, true).length);
}

function bodyContent(
  state: DoneState,
  ctx: { width: number; expanded: boolean },
): BodyPart {
  if (!state.success) {
    return { lines: failureLines(state.error, state.output), block: false };
  }

  const diff = resolveDiff(state);
  if (diff === undefined) {
    // 既没有 metadata 也解析不出输入：至少把工具输出显示出来
    return {
      lines: textLines(state.output).map(line => chalk.dim(line)),
      block: false,
    };
  }

  return { lines: diffBlock(diff, ctx), block: true };
}

// diff 块：一个 entry 一行，整块铺同一种底色
function diffBlock(
  diff: DiffData,
  ctx: { width: number; expanded: boolean },
): string[] {
  const startLine = diff.startLine ?? 1;
  const showGutter = diff.startLine !== undefined;
  const entries = diffEntries(diff, ctx.expanded);
  // 没有行号时（老会话）不画 gutter，只留内容
  const gutterWidth = showGutter ? tokenWidth(entries, startLine) : 0;

  return entries.map(entry =>
    entry.type === 'elision'
      ? elisionLine(gutterWidth, ctx.width)
      : diffLine(entry, { startLine, gutterWidth, width: ctx.width }),
  );
}

// 展开时铺开整段 diff（一条不裁）；折叠时先看整段是否装得下预算，
// 装不下才退回裁过上下文的版本，让改动附近尽量多留几行
function diffEntries(diff: DiffData, expanded: boolean): DiffEntry[] {
  const full = computeLineDiff(
    diff.oldText,
    diff.newText,
    Number.POSITIVE_INFINITY,
  );
  if (expanded || full.length <= collapsedBodyLines) {
    return full;
  }

  return computeLineDiff(diff.oldText, diff.newText);
}

type DiffBlock = {
  startLine: number;
  // 「符号 + 行号」列的总宽度，0 表示不画行号
  gutterWidth: number;
  width: number;
};

// 一行 diff：行号栏 + 内容，整行铺亮色底，底块宽度占满 ctx.width
function diffLine(entry: DiffLine, block: DiffBlock): string {
  const { startLine, gutterWidth, width } = block;
  const sign = gutterSign(entry);
  // 有行号时符号贴左、行号在剩余宽度里右对齐；没有行号时（老会话）符号贴在内容上
  const color =
    entry.type === 'add'
      ? addColor
      : entry.type === 'del'
        ? delColor
        : contextColor;

  return blockRow({
    gutter:
      gutterWidth === 0
        ? ''
        : gutterPrefix(sign, gutterNumber(entry, startLine), gutterWidth),
    content: gutterWidth === 0 ? `${sign}${entry.text}` : entry.text,
    width,
    // 行号跟着正文同色，只有 context 行的行号更暗一档
    gutterColor: entry.type === 'context' ? mutedColor : color,
    contentColor: color,
  });
}

// 折叠分隔线也在同一个底块里，只画一个省略号
function elisionLine(gutterWidth: number, width: number): string {
  return blockRow({
    gutter: gutterIndent(gutterWidth),
    content: '…',
    width,
    contentColor: mutedColor,
    gutterColor: mutedColor,
  });
}

// 符号贴在行号上：add 用新文件行号，del/context 用旧文件行号，context 用空格占位
function gutterSign(line: DiffLine): string {
  if (line.type === 'add') {
    return '+';
  }

  return line.type === 'del' ? '-' : ' ';
}

// 「符号 + 行号」列宽度：符号 1 列 + 最大行号的位数
function tokenWidth(entries: DiffEntry[], startLine: number): number {
  let max = 0;
  for (const entry of entries) {
    if (entry.type === 'elision') {
      continue;
    }

    max = Math.max(max, gutterNumber(entry, startLine));
  }

  return gutterColumnWidth(max);
}

function resolveDiff(state: DoneState): DiffData | undefined {
  const metadata = diffMetadataSchema.safeParse(state.metadata?.diff);
  if (metadata.success) {
    return {
      oldText: metadata.data.oldText,
      newText: metadata.data.newText,
      startLine: metadata.data.startLine,
    };
  }

  // 老会话没有 diff metadata：退回输入里的 oldText/newText，行号未知
  const input = editInputSchema.safeParse(state.input);
  if (!input.success) {
    return undefined;
  }

  return {
    oldText: normalizeToLF(input.data.oldText),
    newText: normalizeToLF(input.data.newText),
  };
}

// 行号栏里的数字：del/context 用旧文件行号，add 用新文件行号
function gutterNumber(line: DiffLine, startLine: number): number {
  const local = line.type === 'add' ? line.newLine : line.oldLine;
  return startLine + (local ?? 1) - 1;
}
