import {execa} from 'execa';
import {
  trackChildProcess,
  untrackChildProcess,
} from 'src/utils/shell.js';
import {type ToolResult, type Tool} from './tool.js';

// Bash 输入
export type BashInput = {
  command: string;
};

// Bash 命令执行超时时间
const bashExecuteTimeout = 30_000;

export const bashTool: Tool<BashInput> = {
  name: 'bash',
  description: '当需要执行bash命令的时候使用',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '待执行的Bash命令',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async execute(input, context): Promise<ToolResult> {
    const execution = execa('bash', ['-lc', input.command], {
      reject: false,
      // 取消时 execa 杀掉整个进程组，连带命令派生的子进程一起
      cancelSignal: context?.signal,
      // 超时走同一条 kill 路径，同样杀掉整个进程组
      timeout: bashExecuteTimeout,
      killDescendants: true,
      // 先 SIGTERM 给进程清理的机会，1 秒后仍不退则升级 SIGKILL
      forceKillAfterDelay: 1000,
    });
    // Execa 在调用时同步完成 spawn，pid 立刻可用；
    // 登记 pid 是为了进程退出时的兜底清理（见 utils/child-process.ts）
    const childPid = execution.pid;
    if (childPid !== undefined) {
      trackChildProcess(childPid);
    }

    let result;
    try {
      result = await execution;
    } finally {
      if (childPid !== undefined) {
        untrackChildProcess(childPid);
      }
    }

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (result.timedOut) {
      return {
        success: false,
        error: `execute timed out after ${bashExecuteTimeout / 1000} seconds`,
        output,
      };
    }

    if (result.isCanceled) {
      return {
        success: false,
        error: 'execution was canceled',
        output,
      };
    }

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: `Exit code: ${result.exitCode ?? 'unknown'}`,
        output,
      };
    }

    return {
      success: true,
      output,
    };
  },
};
