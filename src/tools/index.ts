import { bashTool } from './bash.ts';
import { editTool } from './edit.ts';
import { readTool } from './read.ts';
import { ToolRegistry } from './types.ts';

export function newToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  registry.register(readTool);
  registry.register(editTool);
  return registry;
}

export { type Tool, ToolRegistry } from './types.ts';
