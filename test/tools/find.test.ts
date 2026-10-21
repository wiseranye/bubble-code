import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { findTool } from '../../src/tools/find.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bubble-find-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFile(name: string, content: string = ''): string {
  const filePath = join(dir, name);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function outputLines(output: string): string[] {
  return output.split('\n').sort();
}

test('recursively matches basenames with smart-case and includes hidden files', async () => {
  writeFile('src/a.ts');
  writeFile('src/nested/b.TS');
  writeFile('.secret/c.ts');
  writeFile('ignored/d.ts');
  writeFile('.gitignore', 'ignored/\n');
  mkdirSync(join(dir, 'folder.ts'));

  const result = await findTool.execute({ pattern: '*.ts' }, { cwd: dir });

  expect(result.success).toBe(true);
  expect(outputLines(result.output)).toEqual([
    '.secret/c.ts',
    'src/a.ts',
    'src/nested/b.TS',
  ]);
  expect(result.metadata).toBeUndefined();
});

test('patterns with a slash match paths relative to any search root', async () => {
  writeFile('src/a.ts');
  writeFile('nested/src/b.ts');
  writeFile('other/c.ts');

  const result = await findTool.execute(
    { pattern: 'src/*.ts', path: dir },
    { cwd: dir },
  );

  expect(result.success).toBe(true);
  expect(outputLines(result.output)).toEqual(['nested/src/b.ts', 'src/a.ts']);
});

test('returns paths relative to the search directory', async () => {
  writeFile('src/a.ts');

  const result = await findTool.execute(
    { pattern: '*.ts', path: 'src' },
    { cwd: dir },
  );

  expect(result.output).toBe('a.ts');
});

test('treats leading # and ! as literal pattern characters', async () => {
  writeFile('#notes.ts');
  writeFile('!important.ts');
  writeFile('normal.ts');

  const hashResult = await findTool.execute({ pattern: '#*.ts' }, { cwd: dir });
  const bangResult = await findTool.execute({ pattern: '!*.ts' }, { cwd: dir });

  expect(hashResult.output).toBe('#notes.ts');
  expect(bangResult.output).toBe('!important.ts');
});

test('excludes symlinks and directories', async () => {
  writeFile('real.ts');
  writeFile('folder/child.ts');
  mkdirSync(join(dir, 'folder.ts'));
  if (process.platform !== 'win32') {
    symlinkSync(join(dir, 'real.ts'), join(dir, 'link.ts'));
  }

  const result = await findTool.execute({ pattern: '*' }, { cwd: dir });

  expect(result.success).toBe(true);
  expect(outputLines(result.output)).toEqual(['folder/child.ts', 'real.ts']);
});

test('limit is global and reports even when exactly N files match', async () => {
  writeFile('a.ts');
  writeFile('b.ts');
  writeFile('c.ts');

  const result = await findTool.execute(
    { pattern: '*.ts', limit: 2 },
    { cwd: dir },
  );

  const lines = result.output.split('\n');
  expect(lines).toHaveLength(4);
  expect(lines[2]).toBe('');
  expect(lines[3]).toBe(
    '[2 results limit reached. Use limit=4 for more, or refine pattern]',
  );
  expect(result.metadata).toEqual({ resultLimitReached: 2 });
});

test('returns the pi-compatible empty result', async () => {
  writeFile('a.txt');

  const result = await findTool.execute({ pattern: '*.ts' }, { cwd: dir });

  expect(result).toEqual({
    success: true,
    output: 'No files found matching pattern',
  });
});

test('truncates output at 50KB and exposes truncation metadata', async () => {
  for (let index = 0; index < 250; index++) {
    writeFile(`f${index}-${'x'.repeat(200)}.txt`);
  }

  const result = await findTool.execute({ pattern: '*.txt' }, { cwd: dir });

  expect(result.success).toBe(true);
  expect(result.output.endsWith('\n\n[50.0KB limit reached]')).toBe(true);
  expect(result.metadata?.truncation).toMatchObject({
    truncated: true,
    truncatedBy: 'bytes',
    maxBytes: 50 * 1024,
  });
});

test('rejects absolute globs', async () => {
  writeFile('a.ts');
  const result = await findTool.execute({ pattern: '/tmp/*' }, { cwd: dir });

  expect(result.success).toBe(false);
  expect(result.error).toBe('pattern must not start with "/"');
});

test('rejects files and missing paths', async () => {
  const filePath = writeFile('a.ts');

  const fileResult = await findTool.execute(
    { pattern: '*.ts', path: filePath },
    { cwd: dir },
  );
  const missingResult = await findTool.execute(
    { pattern: '*.ts', path: 'missing' },
    { cwd: dir },
  );

  expect(fileResult.success).toBe(false);
  expect(fileResult.error).toBe(`Path is not a directory: ${filePath}`);
  expect(missingResult.success).toBe(false);
  expect(missingResult.error).toBe(`Path not found: ${join(dir, 'missing')}`);
});

test('rejects invalid arguments and invalid globs', async () => {
  const emptyPattern = await findTool.execute({ pattern: '' }, { cwd: dir });
  const zeroLimit = await findTool.execute(
    { pattern: '*', limit: 0 },
    { cwd: dir },
  );
  const invalidGlob = await findTool.execute({ pattern: '[' }, { cwd: dir });

  expect(emptyPattern.success).toBe(false);
  expect(zeroLimit.success).toBe(false);
  expect(invalidGlob.success).toBe(false);
  expect(invalidGlob.error).toContain('error parsing glob');
});

test('an aborted signal returns a failure', async () => {
  const result = await findTool.execute(
    { pattern: '*' },
    { cwd: dir, signal: AbortSignal.abort() },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBe('operation aborted');
});
