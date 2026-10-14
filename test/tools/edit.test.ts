import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { editTool } from '../../src/tools/edit.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bubble-edit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

// 直接读原始字节，避免 utf8 解码掩盖行尾/BOM 差异
function readFile(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

test('replaces a unique match', async () => {
  writeFile('a.txt', 'const a = 1;\nconst b = 2;\n');
  const result = await editTool.execute(
    { filePath: 'a.txt', oldText: 'const a = 1;', newText: 'const a = 42;' },
    { cwd: dir },
  );

  expect(result.success).toBe(true);
  expect(result.output).toBe('Replaced 1 occurrence in a.txt');
  expect(readFile('a.txt')).toBe('const a = 42;\nconst b = 2;\n');
});

test('an empty newText deletes the match', async () => {
  writeFile('a.txt', 'keep\ndrop\nkeep\n');
  const result = await editTool.execute(
    { filePath: 'a.txt', oldText: 'drop\n', newText: '' },
    { cwd: dir },
  );

  expect(result.success).toBe(true);
  expect(readFile('a.txt')).toBe('keep\nkeep\n');
});

test('a missing match is reported without touching the file', async () => {
  writeFile('a.txt', 'hello\n');
  const result = await editTool.execute(
    { filePath: 'a.txt', oldText: 'nope', newText: 'x' },
    { cwd: dir },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBe(
    'Could not find the text in a.txt. The oldText must match exactly including all whitespace and newlines.',
  );
  expect(readFile('a.txt')).toBe('hello\n');
});

test('an ambiguous match requires replaceAll', async () => {
  writeFile('a.txt', 'x\nx\n');
  const result = await editTool.execute(
    { filePath: 'a.txt', oldText: 'x', newText: 'y' },
    { cwd: dir },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBe(
    'Found 2 occurrences of the text in a.txt. The text must be unique; provide more context to make it unique, or set replaceAll: true.',
  );
  expect(readFile('a.txt')).toBe('x\nx\n');
});

test('replaceAll replaces every match', async () => {
  writeFile('a.txt', 'x\nx\n');
  const result = await editTool.execute(
    { filePath: 'a.txt', oldText: 'x', newText: 'y', replaceAll: true },
    { cwd: dir },
  );

  expect(result.success).toBe(true);
  expect(result.output).toBe('Replaced 2 occurrences in a.txt');
  expect(readFile('a.txt')).toBe('y\ny\n');
});

test('an empty or identical oldText is rejected up front', async () => {
  writeFile('a.txt', 'a\n');

  const empty = await editTool.execute(
    { filePath: 'a.txt', oldText: '', newText: 'b' },
    { cwd: dir },
  );
  expect(empty.success).toBe(false);
  expect(empty.error).toBe('oldText must not be empty');

  const identical = await editTool.execute(
    { filePath: 'a.txt', oldText: 'a', newText: 'a' },
    { cwd: dir },
  );
  expect(identical.success).toBe(false);
  expect(identical.error).toBe(
    'oldText and newText are identical; nothing to change',
  );
});

test('a whitespace-only oldText that cannot match is reported as not found', async () => {
  writeFile('a.txt', 'abc\n');
  const result = await editTool.execute(
    { filePath: 'a.txt', oldText: '   ', newText: 'x' },
    { cwd: dir },
  );

  expect(result.success).toBe(false);
  expect(result.error).toContain('Could not find the text');
});

test('a missing file is reported', async () => {
  const result = await editTool.execute(
    { filePath: 'nope.txt', oldText: 'a', newText: 'b' },
    { cwd: dir },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBe('File not found: nope.txt');
});

test('a CRLF file keeps its line endings', async () => {
  writeFile('a.txt', 'a\r\nb\r\n');
  const result = await editTool.execute(
    { filePath: 'a.txt', oldText: 'b', newText: 'B' },
    { cwd: dir },
  );

  expect(result.success).toBe(true);
  expect(readFile('a.txt')).toBe('a\r\nB\r\n');
});

test('a leading BOM is preserved', async () => {
  writeFile('a.txt', '\uFEFFa\n');
  const result = await editTool.execute(
    { filePath: 'a.txt', oldText: 'a', newText: 'b' },
    { cwd: dir },
  );

  expect(result.success).toBe(true);
  expect(readFile('a.txt')).toBe('\uFEFFb\n');
});

test('a fuzzy match replaces smart quotes and leaves untouched lines byte-identical', async () => {
  writeFile('a.txt', 'const s = \u201Chi\u201D;\nconst t = 1;   \n');
  const result = await editTool.execute(
    {
      filePath: 'a.txt',
      oldText: 'const s = "hi";',
      newText: 'const s = "yo";',
    },
    { cwd: dir },
  );

  expect(result.success).toBe(true);
  expect(result.output).toBe('Replaced 1 occurrence in a.txt (fuzzy match)');
  // 第二行的行尾空白没有被 fuzzy 归一化吃掉
  expect(readFile('a.txt')).toBe('const s = "yo";\nconst t = 1;   \n');
});

test('a fuzzy match that rewrites nothing is rejected', async () => {
  writeFile('a.txt', '\u201Ca\u201D\n');
  const result = await editTool.execute(
    { filePath: 'a.txt', oldText: '"a"', newText: '\u201Ca\u201D' },
    { cwd: dir },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBe(
    'No changes made to a.txt. The replacement produced identical content.',
  );
});

test('an aborted signal is rejected before any write', async () => {
  writeFile('a.txt', 'a\n');
  const result = await editTool.execute(
    { filePath: 'a.txt', oldText: 'a', newText: 'b' },
    { cwd: dir, signal: AbortSignal.abort() },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBe('operation aborted');
  expect(readFile('a.txt')).toBe('a\n');
});
