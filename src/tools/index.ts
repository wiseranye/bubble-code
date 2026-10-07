import { bashTool } from './bash.ts';
import { ToolRegistry } from './types.ts';

export function newToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  return registry;
}

export { type Tool, ToolRegistry } from './types.ts';
