import { bashTool } from './bash.ts';
import { editTool } from './edit.ts';
import { findTool } from './find.ts';
import { grepTool } from './grep.ts';
import { readTool } from './read.ts';
import { ToolRegistry } from './types.ts';
import { writeTool } from './write.ts';

export function newToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  registry.register(readTool);
  registry.register(editTool);
  registry.register(writeTool);
  registry.register(findTool);
  registry.register(grepTool);
  return registry;
}

export { type Tool, ToolRegistry } from './types.ts';
