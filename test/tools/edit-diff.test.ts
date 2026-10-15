import { expect, test } from 'vitest';
import {
  applyReplacements,
  applyReplacementsPreservingUnchangedLines,
  computeLineDiff,
  detectLineEnding,
  findText,
  locateMatch,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
} from '../../src/tools/edit-diff.ts';

test('detectLineEnding reads the ending of the first newline', () => {
  expect(detectLineEnding('a\r\nb')).toBe('\r\n');
  expect(detectLineEnding('a\nb\r\n')).toBe('\n');
  expect(detectLineEnding('a\rb')).toBe('\n');
  expect(detectLineEnding('no newline')).toBe('\n');
});

test('normalizeToLF converts CRLF and lone CR', () => {
  expect(normalizeToLF('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
});

test('restoreLineEndings converts back to CRLF', () => {
  const crlf = 'a\r\nb\r\n';
  expect(restoreLineEndings(normalizeToLF(crlf), '\r\n')).toBe(crlf);
  expect(restoreLineEndings('a\nb\n', '\n')).toBe('a\nb\n');
});

test('normalizeForFuzzyMatch normalizes quotes, dashes, spaces and trailing whitespace', () => {
  expect(
    normalizeForFuzzyMatch('\u201Chi\u201D \u2014 it\u2019s fine   \nx'),
  ).toBe('"hi" - it\'s fine\nx');
});

test('findText reports every exact occurrence', () => {
  const content = 'a\nb\na\n';
  const result = findText(content, 'a');

  expect(result.found).toBe(true);
  expect(result.indices).toEqual([0, 4]);
  expect(result.matchLength).toBe(1);
  expect(result.usedFuzzyMatch).toBe(false);
  expect(result.contentForReplacement).toBe(content);
});

test('findText falls back to fuzzy matching', () => {
  const result = findText('let s = \u201Chi\u201D;', 'let s = "hi";');

  expect(result.found).toBe(true);
  expect(result.usedFuzzyMatch).toBe(true);
  expect(result.indices).toEqual([0]);
  expect(result.matchLength).toBe('let s = "hi";'.length);
  expect(result.contentForReplacement).toBe('let s = "hi";');
});

test('findText finds nothing at all', () => {
  expect(findText('abc', 'zz')).toEqual({
    found: false,
    indices: [],
    matchLength: 0,
    usedFuzzyMatch: false,
    contentForReplacement: 'abc',
  });
});

test('findText ignores needles that normalize to an empty string', () => {
  // '   ' 的 fuzzy 形式是空串，谈不上匹配；带换行的空白 needle 仍会命中换行
  expect(findText('abc\n', '   ').found).toBe(false);

  const withNewline = findText('abc\n', '   \n');
  expect(withNewline.found).toBe(true);
  expect(withNewline.indices).toEqual([3]);
});

test('applyReplacements applies several edits without shifting offsets', () => {
  const result = applyReplacements('one two three', [
    { matchIndex: 0, matchLength: 3, newText: '1' },
    { matchIndex: 8, matchLength: 5, newText: '3' },
  ]);

  expect(result).toBe('1 two 3');
});

test('applyReplacementsPreservingUnchangedLines keeps untouched lines byte-identical', () => {
  const original = 'keep   \nb   \n';
  const base = normalizeForFuzzyMatch(original);
  const result = applyReplacementsPreservingUnchangedLines(original, base, [
    { matchIndex: base.indexOf('b'), matchLength: 1, newText: 'B' },
  ]);

  expect(result).toBe('keep   \nB\n');
});

test('applyReplacementsPreservingUnchangedLines rewrites each touched line', () => {
  const original = 'a  \nb  \n';
  const base = normalizeForFuzzyMatch(original);
  const result = applyReplacementsPreservingUnchangedLines(original, base, [
    { matchIndex: 0, matchLength: 1, newText: 'A' },
    { matchIndex: 2, matchLength: 1, newText: 'B' },
  ]);

  expect(result).toBe('A\nB\n');
});

test('applyReplacementsPreservingUnchangedLines rejects a mismatched line count', () => {
  expect(() =>
    applyReplacementsPreservingUnchangedLines('a\nb\n', 'a\n', [
      { matchIndex: 0, matchLength: 1, newText: 'A' },
    ]),
  ).toThrow(
    'Cannot preserve unchanged lines because the base content has a different line count.',
  );
});

test('applyReplacementsPreservingUnchangedLines rejects a range past the base content', () => {
  expect(() =>
    applyReplacementsPreservingUnchangedLines('a\n', 'a\n', [
      { matchIndex: 0, matchLength: 5, newText: 'x' },
    ]),
  ).toThrow('Replacement range is outside the base content.');
});

test('locateMatch reports the matched text and its 1-based start line', () => {
  expect(locateMatch('a\nbc\nd\n', 2, 2)).toEqual({
    text: 'bc',
    startLine: 2,
  });
  expect(locateMatch('abc', 0, 3)).toEqual({ text: 'abc', startLine: 1 });
});

test('computeLineDiff keeps identical texts as pure context', () => {
  expect(computeLineDiff('a\nb\n', 'a\nb\n')).toEqual([
    { type: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { type: 'context', text: 'b', oldLine: 2, newLine: 2 },
  ]);
});

test('computeLineDiff marks an inserted line as add', () => {
  expect(computeLineDiff('a\nc\n', 'a\nb\nc\n')).toEqual([
    { type: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { type: 'add', text: 'b', newLine: 2 },
    { type: 'context', text: 'c', oldLine: 2, newLine: 3 },
  ]);
});

test('computeLineDiff marks a deleted line as del', () => {
  expect(computeLineDiff('a\nb\nc\n', 'a\nc\n')).toEqual([
    { type: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { type: 'del', text: 'b', oldLine: 2 },
    { type: 'context', text: 'c', oldLine: 3, newLine: 2 },
  ]);
});

test('computeLineDiff renders a replaced block as del followed by add', () => {
  expect(computeLineDiff('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
    { type: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { type: 'del', text: 'b', oldLine: 2 },
    { type: 'add', text: 'B', newLine: 2 },
    { type: 'context', text: 'c', oldLine: 3, newLine: 3 },
  ]);
});

test('computeLineDiff trims context and elides the gap between two changes', () => {
  const oldText = [
    'a',
    'b',
    'B2',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'X',
    'l',
  ];
  const newText = [
    'a',
    'b',
    'B3',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'Y',
    'l',
  ];

  expect(computeLineDiff(oldText.join('\n'), newText.join('\n'))).toEqual([
    { type: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { type: 'context', text: 'b', oldLine: 2, newLine: 2 },
    { type: 'del', text: 'B2', oldLine: 3 },
    { type: 'add', text: 'B3', newLine: 3 },
    { type: 'context', text: 'c', oldLine: 4, newLine: 4 },
    { type: 'context', text: 'd', oldLine: 5, newLine: 5 },
    { type: 'context', text: 'e', oldLine: 6, newLine: 6 },
    { type: 'elision' },
    { type: 'context', text: 'h', oldLine: 9, newLine: 9 },
    { type: 'context', text: 'i', oldLine: 10, newLine: 10 },
    { type: 'context', text: 'j', oldLine: 11, newLine: 11 },
    { type: 'del', text: 'X', oldLine: 12 },
    { type: 'add', text: 'Y', newLine: 12 },
    { type: 'context', text: 'l', oldLine: 13, newLine: 13 },
  ]);
});

test('computeLineDiff keeps every line when the context window is infinite', () => {
  const oldText = ['a', 'b', 'B2', 'c', 'd', 'e'];
  const newText = ['a', 'b', 'B3', 'c', 'd', 'e'];
  const entries = computeLineDiff(
    oldText.join('\n'),
    newText.join('\n'),
    Number.POSITIVE_INFINITY,
  );

  // 改动前后各 3 行都在，没有被裁掉也没有省略标记
  expect(entries).toEqual([
    { type: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { type: 'context', text: 'b', oldLine: 2, newLine: 2 },
    { type: 'del', text: 'B2', oldLine: 3 },
    { type: 'add', text: 'B3', newLine: 3 },
    { type: 'context', text: 'c', oldLine: 4, newLine: 4 },
    { type: 'context', text: 'd', oldLine: 5, newLine: 5 },
    { type: 'context', text: 'e', oldLine: 6, newLine: 6 },
  ]);
});

test('computeLineDiff handles empty texts', () => {
  expect(computeLineDiff('', 'a\n')).toEqual([
    { type: 'add', text: 'a', newLine: 1 },
  ]);
  expect(computeLineDiff('a\n', '')).toEqual([
    { type: 'del', text: 'a', oldLine: 1 },
  ]);
  expect(computeLineDiff('', '')).toEqual([]);
});
