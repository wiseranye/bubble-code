import type { AnyTool, ToolRegistry, ToolSource } from '../tools/types.ts';
import type { McpManager } from './manager.ts';

export class SessionToolRegistry implements ToolSource {
  private readonly builtin: ToolRegistry;
  private readonly mcp: McpManager;
  private readonly cwd: string;

  constructor(builtin: ToolRegistry, mcp: McpManager, cwd: string) {
    this.builtin = builtin;
    this.mcp = mcp;
    this.cwd = cwd;
  }

  list(): AnyTool[] {
    return [...this.builtin.list(), ...this.mcp.toolsFor(this.cwd)];
  }

  find(name: string): AnyTool {
    const tool = this.get(name);
    if (tool === undefined) {
      throw new Error(`unknown tool: ${name}`);
    }
    return tool;
  }

  get(name: string): AnyTool | undefined {
    return (
      this.builtin.get(name) ??
      this.mcp.toolsFor(this.cwd).find(tool => tool.name === name)
    );
  }
}
