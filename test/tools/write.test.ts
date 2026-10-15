import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { writeTool } from '../../src/tools/write.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bubble-write-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('writes a new file and creates missing parent directories', async () => {
  const result = await writeTool.execute(
    { filePath: 'nested/dir/a.txt', content: 'hello' },
    { cwd: dir },
  );

  expect(result.success).toBe(true);
  expect(result.output).toBe('Successfully wrote to nested/dir/a.txt');
  expect(readFileSync(join(dir, 'nested/dir/a.txt'), 'utf8')).toBe('hello');
});

test('overwrites an existing file', async () => {
  writeFileSync(join(dir, 'a.txt'), 'old');
  const result = await writeTool.execute(
    { filePath: 'a.txt', content: 'new' },
    { cwd: dir },
  );

  expect(result.success).toBe(true);
  expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('new');
});

test('resolves the path against cwd, stripping @ and normalizing unicode spaces', async () => {
  const result = await writeTool.execute(
    { filePath: '@sub\u00A0dir/a.txt', content: 'x' },
    { cwd: dir },
  );

  expect(result.success).toBe(true);
  expect(existsSync(join(dir, 'sub dir/a.txt'))).toBe(true);
});

test('an aborted signal is rejected before any write', async () => {
  const result = await writeTool.execute(
    { filePath: 'a.txt', content: 'x' },
    { cwd: dir, signal: AbortSignal.abort() },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBe('operation aborted');
  expect(existsSync(join(dir, 'a.txt'))).toBe(false);
});

test('a parent path that is a file surfaces the filesystem error', async () => {
  writeFileSync(join(dir, 'blocker'), 'not a directory');
  const result = await writeTool.execute(
    { filePath: 'blocker/a.txt', content: 'x' },
    { cwd: dir },
  );

  expect(result.success).toBe(false);
  expect(result.output).toBe('');
  expect(result.error).toBeTruthy();
});

// 权限位对 root 不生效，跳过
test.skipIf(process.getuid?.() === 0)(
  'an unwritable file names the write stage',
  async () => {
    writeFileSync(join(dir, 'ro.txt'), 'old');
    chmodSync(join(dir, 'ro.txt'), 0o444);

    const result = await writeTool.execute(
      { filePath: 'ro.txt', content: 'new' },
      { cwd: dir },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to write ro.txt');
    expect(result.error).toContain('EACCES');
    expect(readFileSync(join(dir, 'ro.txt'), 'utf8')).toBe('old');
  },
);
