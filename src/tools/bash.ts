import { execa } from 'execa';
import Type, { type Static } from 'typebox';
import type { Tool, ToolResult } from './types.ts';

// Bash 输入
const bashInputSchema = Type.Object({
  command: Type.String(),
});

export type BashInput = Static<typeof bashInputSchema>;

// Bash 命令执行超时时间
const bashExecuteTimeout = 30_000;

export const bashTool: Tool<typeof bashInputSchema> = {
  name: 'bash',
  description: '当需要执行bash命令的时候使用',
  inputSchema: bashInputSchema,
  async execute(input: BashInput): Promise<ToolResult> {
    const result = await execa('bash', ['-lc', input.command], {
      reject: false,
      timeout: bashExecuteTimeout,
    });
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
