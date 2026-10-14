// 工具上下文
export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

// 工具定义
export type Tool<TInput = unknown> = {
  name: string;
  description: string;
  // JSON Schema 格式的参数定义，由 defineTool 从 zod schema 转换而来
  inputSchema: Record<string, unknown>;
  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
};

export type AnyTool = Tool;

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

  register<T>(tool: Tool<T>): void {
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
