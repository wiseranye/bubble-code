import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolvePath } from '../utils/paths.ts';
import { defineTool } from './schema.ts';
import type { ToolContext, ToolResult } from './types.ts';
import { writeRenderer } from './write.render.ts';
import { type WriteInput, writeInputSchema } from './write-input.ts';

export const writeTool = defineTool({
  name: 'write',
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  inputSchema: writeInputSchema,
  render: writeRenderer,
  async execute(input: WriteInput, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal?.aborted) {
      return { success: false, output: '', error: 'operation aborted' };
    }

    const absolutePath = resolvePath(input.filePath, ctx.cwd, {
      normalizeUnicodeSpaces: true,
      stripAtPrefix: true,
    });

    // 自动创建父目录
    try {
      await mkdir(dirname(absolutePath), { recursive: true });
    } catch (error: unknown) {
      return {
        success: false,
        output: '',
        error: `Failed to create parent directories for ${input.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (ctx.signal?.aborted) {
      return { success: false, output: '', error: 'operation aborted' };
    }

    try {
      await writeFile(absolutePath, input.content, 'utf8');
      return {
        success: true,
        output: `Successfully wrote to ${input.filePath}`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        output: '',
        error: `Failed to write ${input.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
