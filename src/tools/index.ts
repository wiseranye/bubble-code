import { bashTool } from './bash.ts';
import { ToolRegistry } from './tool.ts';

export function newToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  return registry;
}

export { type Tool, ToolRegistry } from './tool.ts';
