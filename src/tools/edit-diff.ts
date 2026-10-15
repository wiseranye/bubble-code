/**
 * edit 工具的纯文本匹配/替换逻辑。
 * 参考 pi 的 edit-diff.ts，适配单处替换 + replaceAll 的设计。
 */

/** 检测文件主行尾：看第一个 \n 前面是不是 \r */
export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfIndex = content.indexOf('\r\n');
  const lfIndex = content.indexOf('\n');
  if (lfIndex === -1 || crlfIndex === -1) return '\n';
  return crlfIndex < lfIndex ? '\r\n' : '\n';
}

/** 归一化为 LF（含孤立的 \r），让模型不含 \r 的 oldText 也能匹配 CRLF 文件 */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(
  text: string,
  ending: '\r\n' | '\n',
): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * fuzzy 匹配用的归一化：
 * - NFKC 归一化
 * - 剥离每行行尾空白
 * - 智能引号 → ASCII 引号
 * - 各种 Unicode 连字符/破折号 → -
 * - 特殊 Unicode 空格 → 普通空格
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize('NFKC')
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
      // 智能单引号
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // 智能双引号
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // 各种 dash → 连字符
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
      // 特殊空格 → 普通空格
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
  );
}

export interface TextReplacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
}

export interface FindTextResult {
  found: boolean;
  /** 所有匹配的起始下标（位于 contentForReplacement 中） */
  indices: number[];
  matchLength: number;
  usedFuzzyMatch: boolean;
  /**
   * 替换操作应该作用的内容。
   * 精确匹配时是原始内容；fuzzy 匹配时是 fuzzy 归一化后的内容。
   */
  contentForReplacement: string;
}

function findAllIndices(content: string, search: string): number[] {
  const indices: number[] = [];
  // 空 needle 时 indexOf 永远命中且 from 不前移，会死循环；调用方应保证非空，这里兑底
  if (search === '') return indices;
  let from = 0;
  for (;;) {
    const index = content.indexOf(search, from);
    if (index === -1) return indices;
    indices.push(index);
    from = index + search.length;
  }
}

/** 先精确匹配，失败后在 fuzzy 归一化空间里再找一次 */
export function findText(content: string, oldText: string): FindTextResult {
  const exactIndices = findAllIndices(content, oldText);
  if (exactIndices.length > 0) {
    return {
      found: true,
      indices: exactIndices,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  // 纯空白 oldText 会被归一化成空串，谈不上匹配，直接判未找到
  if (fuzzyOldText === '') {
    return {
      found: false,
      indices: [],
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }
  const fuzzyIndices = findAllIndices(fuzzyContent, fuzzyOldText);
  if (fuzzyIndices.length === 0) {
    return {
      found: false,
      indices: [],
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  return {
    found: true,
    indices: fuzzyIndices,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

/** 倒序应用替换，保持偏移稳定 */
export function applyReplacements(
  content: string,
  replacements: TextReplacement[],
): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]!;
    result =
      result.slice(0, replacement.matchIndex) +
      replacement.newText +
      result.slice(replacement.matchIndex + replacement.matchLength);
  }
  return result;
}

/** 按行切分，每行保留自己的行尾 */
function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
  start: number;
  end: number;
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map(line => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

/** 替换区间覆盖的行范围 [startLine, endLine) */
function getReplacementLineRange(
  lines: LineSpan[],
  replacement: TextReplacement,
): { startLine: number; endLine: number } {
  const replacementEnd = replacement.matchIndex + replacement.matchLength;

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      replacement.matchIndex >= line.start &&
      replacement.matchIndex < line.end
    ) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error('Replacement range is outside the base content.');
  }

  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error('Replacement range is outside the base content.');
  }

  return { startLine, endLine: endLine + 1 };
}

/**
 * 把在 baseContent（归一化视图）上匹配的替换应用回 originalContent，
 * 未触及的行保留原始字节，避免 fuzzy 归一化污染整个文件。
 */
export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      'Cannot preserve unchanged lines because the base content has a different line count.',
    );
  }

  // 把触及相同行的替换分到一起，同组在 base 内容上一起做替换
  const groups: Array<{
    startLine: number;
    endLine: number;
    replacements: TextReplacement[];
  }> = [];
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sorted) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = '';
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join('');

    const groupStart = baseLines[group.startLine]!.start;
    const groupEnd = baseLines[group.endLine - 1]!.end;
    const groupReplacements = group.replacements.map(r => ({
      ...r,
      matchIndex: r.matchIndex - groupStart,
    }));
    result += applyReplacements(
      baseContent.slice(groupStart, groupEnd),
      groupReplacements,
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join('');

  return result;
}

/** 匹配区间在内容中的位置：匹配到的原文 + 1-based 起始行号 */
export function locateMatch(
  content: string,
  matchIndex: number,
  matchLength: number,
): { text: string; startLine: number } {
  const startLine = content.slice(0, matchIndex).split('\n').length;
  return {
    text: content.slice(matchIndex, matchIndex + matchLength),
    startLine,
  };
}

export type DiffEntryType = 'context' | 'del' | 'add';

/**
 * 一行 diff：context 有旧/新两个行号，del 只有旧行号，add 只有新行号，
 * 行号都是各自文本内的 1-based 行号。
 */
export interface DiffLine {
  type: DiffEntryType;
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** 改动之间被裁掉的行，渲染成一条省略分隔线 */
export interface DiffElision {
  type: 'elision';
}

export type DiffEntry = DiffLine | DiffElision;

/** 改动前后各保留的上下文行数 */
export const diffContextLines = 3;

/** 按行切分：末尾单个换行只算行终止符，空文本没有行 */
function splitDiffText(text: string): string[] {
  if (text === '') return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

interface DiffOp {
  type: DiffEntryType;
  text: string;
}

/** 逐行走一遍最长公共子序列，输出未编号、未裁上下文的原始操作序列 */
function diffOps(oldLines: string[], newLines: string[]): DiffOp[] {
  // 公共前后缀先砍掉，LCS 只需要处理真正变化的部分
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const ops: DiffOp[] = oldLines
    .slice(0, prefix)
    .map(text => ({ type: 'context' as const, text }));

  // lcs[i][j] = oldMiddle[i..] 与 newMiddle[j..] 的最长公共子序列长度
  const lcs: number[][] = Array.from({ length: oldMiddle.length + 1 }, () =>
    new Array<number>(newMiddle.length + 1).fill(0),
  );
  for (let i = oldMiddle.length - 1; i >= 0; i--) {
    for (let j = newMiddle.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        oldMiddle[i] === newMiddle[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  let i = 0;
  let j = 0;
  while (i < oldMiddle.length && j < newMiddle.length) {
    if (oldMiddle[i] === newMiddle[j]) {
      ops.push({ type: 'context', text: oldMiddle[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ type: 'del', text: oldMiddle[i]! });
      i++;
    } else {
      ops.push({ type: 'add', text: newMiddle[j]! });
      j++;
    }
  }
  while (i < oldMiddle.length) {
    ops.push({ type: 'del', text: oldMiddle[i]! });
    i++;
  }
  while (j < newMiddle.length) {
    ops.push({ type: 'add', text: newMiddle[j]! });
    j++;
  }

  for (const text of oldLines.slice(oldLines.length - suffix)) {
    ops.push({ type: 'context', text });
  }

  return ops;
}

/**
 * 按行 diff：改动前后各保留 context 行上下文，间隔更远的地方换成一条省略标记。
 * context 给 Number.POSITIVE_INFINITY 时不裁任何行，也不产生省略标记。
 * 两份文本完全一致时原样返回全部行。
 */
export function computeLineDiff(
  oldText: string,
  newText: string,
  context: number = diffContextLines,
): DiffEntry[] {
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of diffOps(splitDiffText(oldText), splitDiffText(newText))) {
    if (op.type === 'context') {
      lines.push({ type: 'context', text: op.text, oldLine, newLine });
      oldLine++;
      newLine++;
      continue;
    }

    if (op.type === 'del') {
      lines.push({ type: 'del', text: op.text, oldLine });
      oldLine++;
      continue;
    }

    lines.push({ type: 'add', text: op.text, newLine });
    newLine++;
  }

  const keep = new Array<boolean>(lines.length).fill(false);
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.type === 'context') continue;

    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let cursor = from; cursor <= to; cursor++) {
      keep[cursor] = true;
    }
  }
  if (!keep.some(Boolean)) {
    return lines;
  }

  const entries: DiffEntry[] = [];
  let elided = false;
  for (let index = 0; index < lines.length; index++) {
    if (keep[index]) {
      entries.push(lines[index]!);
      elided = false;
      continue;
    }

    if (!elided) {
      entries.push({ type: 'elision' });
      elided = true;
    }
  }

  return entries;
}
