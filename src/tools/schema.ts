import * as z from 'zod';
import type { Tool, ToolContext, ToolResult } from './types.ts';

export interface DefineToolOptions<Input extends z.ZodType> {
  name: string;
  description: string;
  inputSchema: Input;
  execute(input: z.infer<Input>, context: ToolContext): Promise<ToolResult>;
}

export function defineTool<Input extends z.ZodType>(
  options: DefineToolOptions<Input>,
): Tool<z.infer<Input>> {
  return {
    name: options.name,
    description: options.description,
    inputSchema: z.toJSONSchema(options.inputSchema),
    execute: options.execute,
  };
}
