import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { grepTool } from '../../src/tools/grep.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bubble-grep-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
  const filePath = join(dir, name);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

test('sorts matches and skips hidden and ignored files', async () => {
  writeFile('b.ts', 'alpha\n');
  writeFile('a.ts', 'alpha\nbeta alpha\n');
  writeFile('.hidden.ts', 'alpha\n');
  writeFile('ignored.ts', 'alpha\n');
  writeFile('.gitignore', 'ignored.ts\n');
  mkdirSync(join(dir, '.git'));

  const result = await grepTool.execute({ pattern: 'alpha' }, { cwd: dir });

  expect(result).toEqual({
    success: true,
    output: 'a.ts:1:alpha\na.ts:2:beta alpha\nb.ts:1:alpha',
  });
});

test('ignoreCase affects content but not the glob', async () => {
  writeFile('upper.TS', 'ALPHA\n');

  const missed = await grepTool.execute(
    { pattern: 'alpha', glob: '*.ts' },
    { cwd: dir },
  );
  const found = await grepTool.execute(
    { pattern: 'alpha', glob: '*.TS', ignoreCase: true },
    { cwd: dir },
  );

  expect(missed.output).toBe('No matches found.');
  expect(found.output).toBe('upper.TS:1:ALPHA');
});

test('context merges adjacent blocks and separates distant groups', async () => {
  writeFile('a.ts', 'zero\nalpha\nafter\ngap\ngap\nalpha\nafter\n');

  const result = await grepTool.execute(
    { pattern: 'alpha', context: 1 },
    { cwd: dir },
  );

  expect(result.output).toBe(
    [
      'a.ts-1-zero',
      'a.ts:2:alpha',
      'a.ts-3-after',
      '--',
      'a.ts-5-gap',
      'a.ts:6:alpha',
      'a.ts-7-after',
    ].join('\n'),
  );
});

test('limit is global and reports even when exactly N lines match', async () => {
  writeFile('a.ts', 'alpha\nalpha\n');

  const result = await grepTool.execute(
    { pattern: 'alpha', limit: 2 },
    { cwd: dir },
  );

  expect(result.output).toBe(
    'a.ts:1:alpha\na.ts:2:alpha\n\n' +
      '[2 matching lines limit reached. Use limit=4 for more, or refine pattern]',
  );
});

test('trailing context after limit demotes later matches to context', async () => {
  writeFile('a.ts', 'alpha\nalpha\nthird\n');

  const result = await grepTool.execute(
    { pattern: 'alpha', limit: 1, context: 1 },
    { cwd: dir },
  );

  expect(result.output).toBe(
    'a.ts:1:alpha\na.ts-2-alpha\n\n' +
      '[1 matching lines limit reached. Use limit=2 for more, or refine pattern]',
  );
});

test('directory globs use ripgrep exclusion syntax', async () => {
  writeFile('a.ts', 'alpha\n');
  writeFile('b.ts', 'alpha\n');

  const result = await grepTool.execute(
    { pattern: 'alpha', glob: '!a.ts' },
    { cwd: dir },
  );

  expect(result.output).toBe('b.ts:1:alpha');
});

test('explicit files are still filtered by glob relative to their parent', async () => {
  const filePath = writeFile('src/a.ts', 'alpha\n');

  const plain = await grepTool.execute(
    { pattern: 'alpha', path: filePath, glob: '*.ts' },
    { cwd: dir },
  );
  const braced = await grepTool.execute(
    { pattern: 'alpha', path: filePath, glob: '{a,b}.ts' },
    { cwd: dir },
  );
  const withDirectory = await grepTool.execute(
    { pattern: 'alpha', path: filePath, glob: 'src/*.ts' },
    { cwd: dir },
  );
  const excluded = await grepTool.execute(
    { pattern: 'alpha', path: filePath, glob: '!*.ts' },
    { cwd: dir },
  );
  const trimmed = await grepTool.execute(
    { pattern: 'alpha', path: filePath, glob: '*.ts ' },
    { cwd: dir },
  );

  expect(plain.output).toBe('src/a.ts:1:alpha');
  expect(braced.output).toBe('src/a.ts:1:alpha');
  expect(withDirectory.output).toBe('No matches found.');
  expect(excluded.output).toBe('No matches found.');
  expect(trimmed.output).toBe('src/a.ts:1:alpha');
});

test('returns the exact empty result', async () => {
  writeFile('a.ts', 'alpha\n');

  const result = await grepTool.execute({ pattern: 'missing' }, { cwd: dir });

  expect(result).toEqual({ success: true, output: 'No matches found.' });
});

test('truncates long lines and appends one AI notice', async () => {
  writeFile('long.txt', `${'x'.repeat(600)}match\n`);

  const result = await grepTool.execute({ pattern: 'match' }, { cwd: dir });

  expect(result.success).toBe(true);
  expect(result.output).toContain('... [truncated]');
  expect(
    result.output.endsWith(
      '[Long lines truncated to 500 characters. Use read with the reported file path and line number to view full content.]',
    ),
  ).toBe(true);
});

test('stops at 2000 output lines with a line-limit notice', async () => {
  const lines = Array.from({ length: 2100 }, () => 'hit');
  writeFile('large.txt', `${lines.join('\n')}\n`);

  const result = await grepTool.execute(
    { pattern: 'hit', limit: 3000 },
    { cwd: dir },
  );

  const [body, notice] = result.output.split('\n\n');
  expect(body?.split('\n')).toHaveLength(2000);
  expect(notice).toBe(
    '[2000 output lines limit reached. Results are incomplete; refine pattern, glob, or path.]',
  );
  expect(result.output).not.toContain('matching lines limit reached');
});

test('stops at the 50KB output limit after per-line truncation', async () => {
  const lines = Array.from({ length: 120 }, () => `${'x'.repeat(600)}match`);
  writeFile('large.txt', `${lines.join('\n')}\n`);

  const result = await grepTool.execute(
    { pattern: 'match', limit: 3000 },
    { cwd: dir },
  );

  expect(result.success).toBe(true);
  expect(result.output).toContain('Long lines truncated');
  expect(
    result.output.endsWith(
      '[50.0KB output limit reached. Results are incomplete; refine pattern, glob, or path.]',
    ),
  ).toBe(true);
  expect(result.output).not.toContain('2000 output lines limit reached');
});

test('escapes newlines in result paths', async () => {
  if (process.platform === 'win32') {
    return;
  }
  writeFile('line\nname.ts', 'alpha\n');

  const result = await grepTool.execute({ pattern: 'alpha' }, { cwd: dir });

  expect(result.output).toBe('line\\nname.ts:1:alpha');
});

test('rejects invalid arguments and reports ripgrep errors', async () => {
  const emptyPattern = await grepTool.execute({ pattern: '' }, { cwd: dir });
  const zeroLimit = await grepTool.execute(
    { pattern: 'x', limit: 0 },
    { cwd: dir },
  );
  const negativeContext = await grepTool.execute(
    { pattern: 'x', context: -1 },
    { cwd: dir },
  );
  const invalidRegex = await grepTool.execute({ pattern: '[' }, { cwd: dir });
  const missingPath = await grepTool.execute(
    { pattern: 'x', path: 'missing' },
    { cwd: dir },
  );

  expect(emptyPattern.success).toBe(false);
  expect(zeroLimit.success).toBe(false);
  expect(negativeContext.success).toBe(false);
  expect(invalidRegex.success).toBe(false);
  expect(invalidRegex.error).toContain('regex parse error');
  expect(missingPath).toEqual({
    success: false,
    output: '',
    error: `Path not found: ${join(dir, 'missing')}`,
  });
});

test('an aborted signal returns a failure', async () => {
  const result = await grepTool.execute(
    { pattern: 'x' },
    { cwd: dir, signal: AbortSignal.abort() },
  );

  expect(result).toEqual({
    success: false,
    output: '',
    error: 'operation aborted',
  });
});
