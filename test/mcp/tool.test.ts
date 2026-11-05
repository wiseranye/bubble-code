import type {
  CallToolRequestParams,
  CallToolResult,
  Tool as McpServerTool,
} from '@modelcontextprotocol/client';
import { expect, test } from 'vitest';
import {
  createMcpTools,
  type McpToolClient,
  mcpToolName,
} from '../../src/mcp/tool.ts';

function definition(name: string): McpServerTool {
  return {
    name,
    description: `description of ${name}`,
    inputSchema: { type: 'object', properties: {} },
  };
}

test('creates provider-safe, stable MCP tool names', () => {
  expect(mcpToolName('local', 'search')).toBe('mcp__local__search');
  const escaped = mcpToolName('local', 'search.files');
  expect(escaped).toMatch(/^mcp__local__search_files__[a-f0-9]{8}$/);
  expect(escaped.length).toBeLessThanOrEqual(64);
  expect(mcpToolName('local', 'x'.repeat(100))).toHaveLength(64);
  expect(mcpToolName('local', 'a.b')).not.toBe(mcpToolName('local', 'a/b'));
});

test('rejects duplicate MCP tool names', () => {
  const client: McpToolClient = {
    async callTool(): Promise<CallToolResult> {
      return { content: [] };
    },
  };
  expect(() =>
    createMcpTools('local', client, [definition('same'), definition('same')]),
  ).toThrow(/冲突/);
});

test('calls the original MCP tool with timeout, cancellation and schema', async () => {
  const calls: Array<{
    params: CallToolRequestParams;
    signal?: AbortSignal;
  }> = [];
  const serverTool = definition('search');
  const client: McpToolClient = {
    async callTool(params, options): Promise<CallToolResult> {
      calls.push({ params, signal: options?.signal });
      expect(options?.timeout).toBe(60_000);
      expect(options?.toolDefinition).toBe(serverTool);
      return { content: [{ type: 'text', text: 'found' }] };
    },
  };
  const [tool] = createMcpTools('local', client, [serverTool]);
  const controller = new AbortController();
  const result = await tool?.execute(
    { query: 'bubble' },
    { cwd: '/tmp', signal: controller.signal },
  );

  expect(result).toEqual({ success: true, output: 'found' });
  expect(calls).toEqual([
    {
      params: { name: 'search', arguments: { query: 'bubble' } },
      signal: controller.signal,
    },
  ]);
});

test('maps structured, non-text and tool-error results', async () => {
  const results: CallToolResult[] = [
    { content: [], structuredContent: { answer: 42 } },
    {
      content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
    },
    { content: [{ type: 'text', text: 'bad input' }], isError: true },
  ];
  const client: McpToolClient = {
    async callTool(): Promise<CallToolResult> {
      return results.shift() ?? { content: [] };
    },
  };
  const [tool] = createMcpTools('local', client, [definition('run')]);
  if (tool === undefined) {
    throw new Error('tool missing');
  }

  await expect(tool.execute({}, { cwd: '/tmp' })).resolves.toEqual({
    success: true,
    output: '{\n  "answer": 42\n}',
  });
  const image = await tool.execute({}, { cwd: '/tmp' });
  expect(image.success).toBe(true);
  expect(image.output).toContain('"mimeType": "image/png"');
  await expect(tool.execute({}, { cwd: '/tmp' })).resolves.toEqual({
    success: false,
    error: 'MCP 工具返回失败',
    output: 'bad input',
  });
});
