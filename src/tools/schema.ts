import * as z from 'zod';
import type { Tool, ToolContext, ToolRenderer, ToolResult } from './types.ts';

export interface DefineToolOptions<Input extends z.ZodType> {
  name: string;
  description: string;
  inputSchema: Input;
  render?: ToolRenderer;
  isConcurrencySafe(input: z.infer<Input>): boolean;
  execute(input: z.infer<Input>, context: ToolContext): Promise<ToolResult>;
}

export function defineTool<Input extends z.ZodType>(
  options: DefineToolOptions<Input>,
): Tool<z.infer<Input>> {
  return {
    name: options.name,
    description: options.description,
    inputSchema: z.toJSONSchema(options.inputSchema),
    render: options.render,
    isConcurrencySafe: options.isConcurrencySafe,
    execute: options.execute,
  };
}
