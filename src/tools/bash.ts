import { execa } from 'execa';
import * as z from 'zod';
import { defineTool } from './schema.ts';
import type { ToolContext, ToolResult } from './types.ts';

// Bash 输入
const bashInputSchema = z.object({
  command: z.string().meta({
    description: 'The bash command to execute, such as find, ls, or ps.',
  }),
  timeout: z.optional(
    z.number().meta({
      description: 'Timeout in seconds (optional, default 60s)',
    }),
  ),
});

export type BashInput = z.infer<typeof bashInputSchema>;

// Bash 命令执行超时时间
const defaultTimeout = 60_000;

export const bashTool = defineTool({
  name: 'bash',
  description: '当需要执行bash命令的时候使用',
  inputSchema: bashInputSchema,
  async execute(input: BashInput, context: ToolContext): Promise<ToolResult> {
    let timeout: number;
    if (input.timeout === undefined) {
      timeout = defaultTimeout;
    } else if (!Number.isFinite(input.timeout) || input.timeout <= 0) {
      return {
        success: false,
        error: 'timeout must be a positive number',
        output: 'timeout must be a positive number',
      };
    } else {
      timeout = input.timeout * 1000;
    }
    const result = await execa('bash', ['-lc', input.command], {
      reject: false,
      timeout,
      cancelSignal: context.signal,
      cwd: context.cwd,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (result.timedOut) {
      return {
        success: false,
        error: `execute timed out after ${timeout / 1000} seconds`,
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
});
