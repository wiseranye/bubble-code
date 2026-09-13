import {ToolRegistry} from './tool.js';
import {bashTool} from './bash.js';

export function newToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  return registry;
}

export {type Tool, ToolRegistry} from './tool.js';
