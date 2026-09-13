import {execa} from 'execa';
import {ToolResult, type Tool} from './tool.js';

// Bash 输入
export type BashInput = {
  command: string;
};

// Bash 命令执行超时时间
const BASH_EXECUTE_TIMEOUT = 30_000;

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
  async execute(input): Promise<ToolResult> {
    const result = await execa('bash', ['-lc', input.command], {
      reject: false,
      timeout: BASH_EXECUTE_TIMEOUT,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (result.timedOut) {
      return {
        success: false,
        error: `execute timed out after ${BASH_EXECUTE_TIMEOUT} seconds`,
        output: output,
      };
    }
    if (result.isCanceled) {
      return {
        success: false,
        error: 'execution was canceled',
        output: output,
      };
    }
    if (result.exitCode !== 0) {
      return {
        success: false,
        error: `Exit code: ${result.exitCode ?? 'unknown'}`,
        output: output,
      };
    }
    return {
      success: true,
      output: output,
    };
  },
};
