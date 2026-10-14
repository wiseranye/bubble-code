import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as z from 'zod';
import { resolvePath } from '../utils/paths.ts';
import { defineTool } from './schema.ts';
import type { ToolContext, ToolResult } from './types.ts';

// 写文件输入
const writeInputSchema = z.object({
  filePath: z.string().meta({
    description: 'The file path to write (relative or absolute)',
  }),
  content: z.string().meta({
    description: 'Content to write to the file',
  }),
});

export type WriteInput = z.infer<typeof writeInputSchema>;

export const writeTool = defineTool({
  name: 'write',
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  inputSchema: writeInputSchema,
  async execute(input: WriteInput, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal?.aborted) {
      return { success: false, output: '', error: 'operation aborted' };
    }

    const absolutePath = resolvePath(input.filePath, ctx.cwd, {
      normalizeUnicodeSpaces: true,
      stripAtPrefix: true,
    });

    try {
      // 自动创建父目录
      await mkdir(dirname(absolutePath), { recursive: true });

      if (ctx.signal?.aborted) {
        return { success: false, output: '', error: 'operation aborted' };
      }

      await writeFile(absolutePath, input.content, 'utf8');
      return {
        success: true,
        output: `Successfully wrote to ${input.filePath}`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
