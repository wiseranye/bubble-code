import { bashTool } from './bash.ts';
import { readTool } from './read.ts';
import { ToolRegistry } from './types.ts';

export function newToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  registry.register(readTool);
  return registry;
}

export { type Tool, ToolRegistry } from './types.ts';
