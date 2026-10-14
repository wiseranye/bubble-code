import { expect, test } from 'vitest';
import {
  applyReplacements,
  applyReplacementsPreservingUnchangedLines,
  detectLineEnding,
  findText,
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
