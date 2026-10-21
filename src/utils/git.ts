import { execa } from 'execa';

const gitTimeout = 2000;

export type GitBranchState =
  | { kind: 'branch'; name: string }
  | { kind: 'detached'; sha: string }
  | { kind: 'none' };

// 读取 cwd 所在的 Git 分支；非仓库、git 缺失或超时都按 none 处理。
// 空仓库（还没有 commit）没有 HEAD，但 symbolic-ref 仍能给出未出生的分支名。
export async function readGitBranch(cwd: string): Promise<GitBranchState> {
  try {
    const result = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: gitTimeout,
    });
    const name = result.stdout.trim();
    if (name === '') {
      return { kind: 'none' };
    }

    if (name !== 'HEAD') {
      return { kind: 'branch', name };
    }

    const detached = await execa('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      timeout: gitTimeout,
    });
    const sha = detached.stdout.trim();
    return sha === '' ? { kind: 'none' } : { kind: 'detached', sha };
  } catch {
    try {
      const result = await execa('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd,
        timeout: gitTimeout,
      });
      const name = result.stdout.trim();
      return name === '' ? { kind: 'none' } : { kind: 'branch', name };
    } catch {
      return { kind: 'none' };
    }
  }
}
