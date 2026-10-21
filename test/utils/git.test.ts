import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readGitBranch } from '../../src/utils/git.ts';

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bubble-git-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }

  dirs.length = 0;
});

test('non-repository directories yield none', async () => {
  await expect(readGitBranch(makeDir())).resolves.toEqual({ kind: 'none' });
});

test('an unborn branch is read from symbolic-ref', async () => {
  const dir = makeDir();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/test-branch'], {
    cwd: dir,
  });

  await expect(readGitBranch(dir)).resolves.toEqual({
    kind: 'branch',
    name: 'test-branch',
  });
});

test('a committed branch is read, and detached HEAD yields the short sha', async () => {
  const dir = makeDir();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/test-branch'], {
    cwd: dir,
  });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'init',
      '-q',
    ],
    { cwd: dir },
  );

  await expect(readGitBranch(dir)).resolves.toEqual({
    kind: 'branch',
    name: 'test-branch',
  });

  execFileSync('git', ['checkout', '--detach', '-q'], { cwd: dir });

  const result = await readGitBranch(dir);
  expect(result.kind).toBe('detached');
  if (result.kind === 'detached') {
    expect(result.sha).toMatch(/^[0-9a-f]{7,}$/);
  }
});
