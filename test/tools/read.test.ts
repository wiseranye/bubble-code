import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { readTool } from '../../src/tools/read.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bubble-read-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// 在临时目录里造一个文件，返回它的绝对路径
function writeFile(name: string, content: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  return filePath;
}

test('reads a whole file and drops the trailing newline', async () => {
  const filePath = writeFile('a.txt', '第一行\n第二行\n');
  const result = await readTool.execute({ filePath }, { cwd: dir });

  expect(result.success).toBe(true);
  expect(result.output).toBe('第一行\n第二行');
});

test('offset skips leading lines', async () => {
  const filePath = writeFile('a.txt', '1\n2\n3\n');
  const result = await readTool.execute({ filePath, offset: 2 }, { cwd: dir });

  expect(result.output).toBe('2\n3');
});

test('limit hints how to continue when lines remain', async () => {
  const filePath = writeFile('a.txt', '1\n2\n3\n4\n');
  const result = await readTool.execute({ filePath, limit: 2 }, { cwd: dir });

  expect(result.output).toBe(
    '1\n2\n\n[Showing lines 1-2. File has more lines; use offset=3 to continue.]',
  );
});

test('offset and limit combine in the continuation hint', async () => {
  const filePath = writeFile('a.txt', '1\n2\n3\n4\n5\n');
  const result = await readTool.execute(
    { filePath, offset: 2, limit: 2 },
    { cwd: dir },
  );

  expect(result.output).toBe(
    '2\n3\n\n[Showing lines 2-3. File has more lines; use offset=4 to continue.]',
  );
});

test('a limit that exactly covers the rest adds no hint', async () => {
  const filePath = writeFile('a.txt', '1\n2\n');
  const result = await readTool.execute({ filePath, limit: 2 }, { cwd: dir });

  expect(result.output).toBe('1\n2');
});

test('limit 0 with content points at the start line', async () => {
  const filePath = writeFile('a.txt', '1\n2\n');
  const result = await readTool.execute(
    { filePath, offset: 2, limit: 0 },
    { cwd: dir },
  );

  expect(result.output).toBe(
    '[Showing 0 lines (limit=0). File has content from line 2; use a larger limit to read it.]',
  );
});

test('offset beyond the end is reported', async () => {
  const filePath = writeFile('a.txt', '1\n2\n');
  const result = await readTool.execute({ filePath, offset: 9 }, { cwd: dir });

  expect(result.success).toBe(true);
  expect(result.output).toBe('[Offset 9 is beyond the end of the file]');
});

test('an empty file is reported as such', async () => {
  const filePath = writeFile('empty.txt', '');
  const result = await readTool.execute({ filePath }, { cwd: dir });

  expect(result.success).toBe(true);
  expect(result.output).toBe('[File is empty]');
});

test('CRLF line endings are stripped', async () => {
  const filePath = writeFile('crlf.txt', 'a\r\nb\r\n');
  const result = await readTool.execute({ filePath }, { cwd: dir });

  expect(result.output).toBe('a\nb');
});

test('a missing file returns an error result', async () => {
  const filePath = join(dir, 'nope.txt');
  const result = await readTool.execute({ filePath }, { cwd: dir });

  expect(result.success).toBe(false);
  expect(result.output).toBe('');
  expect(result.error).toBe(`File not found: ${filePath}`);
});

test('a directory is rejected', async () => {
  const filePath = join(dir, 'sub');
  mkdirSync(filePath);
  const result = await readTool.execute({ filePath }, { cwd: dir });

  expect(result.success).toBe(false);
  expect(result.error).toBe(`Is a directory: ${filePath}`);
});

test('a non-positive offset surfaces the range error', async () => {
  const filePath = writeFile('a.txt', '1\n');
  const result = await readTool.execute({ filePath, offset: 0 }, { cwd: dir });

  expect(result.success).toBe(false);
  expect(result.error).toBe('offset must be a positive integer');
});

test('a negative limit surfaces the range error', async () => {
  const filePath = writeFile('a.txt', '1\n');
  const result = await readTool.execute({ filePath, limit: -1 }, { cwd: dir });

  expect(result.success).toBe(false);
  expect(result.error).toBe('limit must be a non-negative integer');
});

test('long files are cut at the line limit with a continuation hint', async () => {
  const lines = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`);
  const filePath = writeFile('big.txt', `${lines.join('\n')}\n`);
  const result = await readTool.execute({ filePath }, { cwd: dir });

  expect(
    result.output.endsWith(
      '[Showing lines 1-2000 of 3000. Use offset=2001 to continue.]',
    ),
  ).toBe(true);
});

test('a single line over the byte limit suggests bash instead', async () => {
  const filePath = writeFile('long.txt', 'x'.repeat(60 * 1024));
  const result = await readTool.execute({ filePath }, { cwd: dir });

  expect(result.output).toBe(
    `[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' ${filePath} | head -c 51200]`,
  );
});
