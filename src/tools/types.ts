import type { Static, TSchema } from 'typebox';

// 工具定义
export type Tool<ToolInput extends TSchema> = {
  name: string;
  description: string;
  inputSchema: ToolInput;
  execute(input: Static<ToolInput>): Promise<ToolResult>;
};

export type AnyTool = Tool<TSchema>;

// 工具结果
export type ToolResult = {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

// 工具注册中心
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register<T extends TSchema>(tool: Tool<T>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already defined: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  find(name: string): AnyTool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }

    return tool;
  }
}
