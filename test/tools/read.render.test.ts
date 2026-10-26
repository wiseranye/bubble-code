import { expect, test } from 'vitest';
import { isSkillReadInput, readRenderer } from '../../src/tools/read.render.ts';

function summarise(input: unknown): string | undefined {
  return readRenderer.summarise?.(input);
}

test('read summary is the file path when there is no line range', () => {
  expect(summarise({ filePath: 'src/app.ts' })).toBe('src/app.ts');
});

test('read summary spells out the requested line range', () => {
  expect(summarise({ filePath: 'src/app.ts', offset: 10, limit: 20 })).toBe(
    'src/app.ts（第 10 行起，共 20 行）',
  );
  expect(summarise({ filePath: 'src/app.ts', offset: 10 })).toBe(
    'src/app.ts（从第 10 行起）',
  );
  expect(summarise({ filePath: 'src/app.ts', limit: 20 })).toBe(
    'src/app.ts（前 20 行）',
  );
});

test('read summary falls back to a JSON-ish line when the input does not parse', () => {
  expect(summarise({ filePath: 42 })).toBe('{"filePath":42}');
  expect(summarise({ offset: 5 })).toBe('{"offset":5}');
});

test('read summary collapses a single string value and truncates extra lines', () => {
  expect(summarise('第一行\n第二行')).toBe('第一行 …');
  expect(summarise({ note: '第一行\n第二行' })).toBe('第一行 …');
});

test('only an exact SKILL.md basename selects skill rendering', () => {
  expect(isSkillReadInput({ filePath: 'SKILL.md' })).toBe(true);
  expect(isSkillReadInput({ filePath: '/tmp/a/SKILL.md' })).toBe(true);
  expect(isSkillReadInput({ filePath: 'C:\\a\\SKILL.md' })).toBe(true);
  expect(isSkillReadInput({ filePath: '/tmp/a/skill.md' })).toBe(false);
  expect(isSkillReadInput({ filePath: '/tmp/a/SKILL.md.bak' })).toBe(false);
  expect(isSkillReadInput({ filePath: '/tmp/a/not-SKILL.md' })).toBe(false);
});
