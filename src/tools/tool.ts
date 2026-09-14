// 工具执行上下文（目前只有取消信号）
export type ToolContext = {
  signal?: AbortSignal;
};

// 工具定义
export type Tool<ToolInput = Record<string, unknown>> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: ToolInput, context?: ToolContext): Promise<ToolResult>;
};

// 工具调用
export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputRaw: string;
};

// 工具结果
export type ToolResult = {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

// 工具注册中心
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already defined: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  find(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }

    return tool;
  }
}
