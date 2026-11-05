import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { expect, test } from 'vitest';
import type { McpConnection } from '../../src/mcp/manager.ts';
import { McpPicker } from '../../src/ui/mcp-picker.ts';

const entries: McpConnection[] = [
  {
    serverName: 'codegraph',
    cwd: '/work/project',
    status: 'connected',
    tools: [
      {
        name: 'mcp__codegraph__codegraph_explore',
        description: 'Explore the code graph',
      },
    ],
  },
  {
    serverName: 'broken',
    cwd: '/work/project',
    status: 'failed',
    tools: [],
    error: 'boom',
  },
];

function render(picker: McpPicker): string {
  return stripTerminalSequences(picker.render(100).join('\n'));
}

test('shows all MCP connections and expands tools for a connected server', () => {
  const picker = new McpPicker(
    () => entries,
    () => {},
    () => {},
  );
  const initial = render(picker);
  expect(initial).toContain('✓ codegraph');
  expect(initial).toContain('✗ broken');
  expect(initial).toContain('已连接 · /work/project');
  expect(initial).toContain('连接失败 · /work/project');
  expect(initial).not.toContain('Explore the code graph');

  picker.handleInput('\r');
  const expanded = render(picker);
  expect(expanded).toContain('工具列表（1）');
  expect(expanded).toContain('mcp__codegraph__codegraph_explore');
  expect(expanded).toContain('Explore the code graph');

  picker.handleInput('\r');
  expect(render(picker)).not.toContain('Explore the code graph');
});

test('failed servers show the error and cannot expand tools', () => {
  const picker = new McpPicker(
    () => entries,
    () => {},
    () => {},
  );
  picker.handleInput('\x1b[B');
  picker.handleInput('\r');

  const line = render(picker);
  expect(line).toContain('失败原因：boom');
  expect(line).not.toContain('工具列表');
});

test('refreshes asynchronous connection changes without reopening', () => {
  const currentEntries: McpConnection[] = [
    {
      serverName: 'local',
      cwd: '/work/project',
      status: 'connecting',
      tools: [],
    },
  ];
  const picker = new McpPicker(
    () => currentEntries,
    () => {},
    () => {},
  );
  expect(render(picker)).toContain('连接中');

  currentEntries[0]!.status = 'connected';
  currentEntries[0]!.tools = [
    { name: 'mcp__local__search', description: 'Search' },
  ];
  expect(render(picker)).toContain('已连接');
  picker.handleInput('\r');
  expect(render(picker)).toContain('mcp__local__search');
});
