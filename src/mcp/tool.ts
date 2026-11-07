import { createHash } from 'node:crypto';
import {
  type CallToolResult,
  type Client,
  type Tool as McpServerTool,
  SdkError,
  SdkErrorCode,
} from '@modelcontextprotocol/client';
import type { AnyTool, ToolResult } from '../tools/types.ts';
import { truncateHead } from '../utils/truncate.ts';

const maxToolNameLength = 64;
const toolTimeoutMs = 60_000;

export type McpToolClient = Pick<Client, 'callTool'>;

export function mcpToolName(serverName: string, toolName: string): string {
  const safeToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const base = `mcp__${serverName}__${safeToolName}`;
  if (base.length <= maxToolNameLength && safeToolName === toolName) {
    return base;
  }

  const hash = createHash('sha256')
    .update(`${serverName}\0${toolName}`)
    .digest('hex')
    .slice(0, 8);
  const suffix = `__${hash}`;
  return `${base.slice(0, maxToolNameLength - suffix.length)}${suffix}`;
}

export function createMcpTools(
  serverName: string,
  client: McpToolClient,
  definitions: readonly McpServerTool[],
): AnyTool[] {
  const names = new Set<string>();
  return definitions.map(definition => {
    const name = mcpToolName(serverName, definition.name);
    if (names.has(name)) {
      throw new Error(`MCP Server ${serverName} 的工具名编码后冲突：${name}`);
    }
    names.add(name);

    return {
      name,
      description: definition.description ?? `MCP tool: ${definition.name}`,
      inputSchema: { ...definition.inputSchema },
      isConcurrencySafe: () => true,
      async execute(input: unknown, context): Promise<ToolResult> {
        if (
          input === null ||
          typeof input !== 'object' ||
          Array.isArray(input)
        ) {
          return {
            success: false,
            error: 'MCP 工具输入必须是对象',
            output: '',
          };
        }

        let result: CallToolResult;
        try {
          result = await client.callTool(
            {
              name: definition.name,
              arguments: input as Record<string, unknown>,
            },
            {
              timeout: toolTimeoutMs,
              resetTimeoutOnProgress: false,
              signal: context.signal,
              toolDefinition: definition,
            },
          );
        } catch (error: unknown) {
          if (
            error instanceof SdkError &&
            (error.code === SdkErrorCode.UnsupportedResultType ||
              error.code === SdkErrorCode.InputRequiredRoundsExceeded)
          ) {
            return {
              success: false,
              error: '不支持的 MCP 交互能力',
              output: '',
            };
          }
          throw error;
        }

        return mapToolResult(result);
      },
    };
  });
}

function mapToolResult(result: CallToolResult): ToolResult {
  const rawOutput =
    result.structuredContent !== undefined
      ? JSON.stringify(result.structuredContent, null, 2)
      : result.content
          .map(block =>
            block.type === 'text' ? block.text : JSON.stringify(block, null, 2),
          )
          .join('\n');
  const truncated = truncateHead(rawOutput);
  const output = truncated.truncated
    ? `${truncated.content}\n[MCP 输出已截断，原始大小 ${truncated.totalBytes} 字节]`
    : truncated.content;

  return result.isError
    ? { success: false, error: 'MCP 工具返回失败', output }
    : { success: true, output };
}
