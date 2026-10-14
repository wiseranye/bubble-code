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
