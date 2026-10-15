// 工具上下文
export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

// 工具渲染状态：running/streaming 只有输入，done 才有结果
export type ToolRenderState =
  | { status: 'running'; input: unknown }
  // streaming 预留给流式输出，暂无调用方
  | { status: 'streaming'; input: unknown; partial: string }
  | {
      status: 'done';
      input: unknown;
      output: string;
      error?: string;
      success: boolean;
      metadata?: Record<string, unknown>;
    };

// 工具渲染器：summarise 把参数压成一行，renderBody 按状态渲染正文
export interface ToolRenderer {
  summarise?(input: unknown): string;
  renderBody?(
    state: ToolRenderState,
    ctx: { width: number; expanded: boolean },
  ): string[];
  // 折叠预览之外还有内容吗（展开能看到更多行）。
  // 调用方靠这个决定展开/收起入口，不能用正文行数反推：折叠正文的末尾会带一行
  // 「… 还有 N 行，点击展开」提示，只有 9 行内容时折叠和展开的行数一样多。
  // 定义 renderBody 的渲染器应当一起给出它；缺省时按通用正文的预算判断
  hasMoreBody?(state: ToolRenderState): boolean;
}

// 工具定义
export type Tool<TInput = unknown> = {
  name: string;
  description: string;
  // JSON Schema 格式的参数定义，由 defineTool 从 zod schema 转换而来
  inputSchema: Record<string, unknown>;
  // 该工具的界面渲染器；没有渲染器的工具由调用方走通用渲染
  render?: ToolRenderer;
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

  // 非抛出版本：恢复的历史会话可能引用已经改名或删除的工具
  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }
}
