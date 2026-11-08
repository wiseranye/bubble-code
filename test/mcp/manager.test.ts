import { expect, test, vi } from 'vitest';
import type { McpConfig } from '../../src/mcp/config.ts';
import type {
  LoadedMcpServer,
  LoadMcpServerOptions,
} from '../../src/mcp/loader.ts';
import { McpManager } from '../../src/mcp/manager.ts';
import type { AnyTool } from '../../src/tools/types.ts';

const config: McpConfig = {
  mcpServers: {
    local: { type: 'stdio', command: 'local-mcp', args: [], env: {} },
  },
};

function loadedTool(name = 'mcp__local__search'): AnyTool {
  return {
    name,
    description: 'search',
    inputSchema: { type: 'object' },
    isConcurrencySafe: () => true,
    async execute() {
      return { success: true, output: 'ok' };
    },
  };
}

function loaded(name?: string): LoadedMcpServer {
  return { tools: [loadedTool(name)], close: vi.fn(async () => {}) };
}

test('deduplicates loading and isolates state by cwd', async () => {
  const resolvers = new Map<string, (server: LoadedMcpServer) => void>();
  const loader = vi.fn(async (options: LoadMcpServerOptions) => {
    return new Promise<LoadedMcpServer>(resolve => {
      resolvers.set(options.cwd, resolve);
    });
  });
  const manager = new McpManager(config, [], loader);
  const first = manager.start(process.cwd(), () => {});
  const shared = manager.start(process.cwd(), () => {});
  const other = manager.start('/', () => {});
  await Promise.resolve();

  expect(loader).toHaveBeenCalledTimes(2);
  expect(manager.toolsFor(process.cwd())).toEqual([]);
  resolvers.get(process.cwd())?.(loaded());
  await Promise.all([first, shared]);
  expect(manager.toolsFor(process.cwd()).map(tool => tool.name)).toEqual([
    'mcp__local__search',
  ]);
  expect(manager.toolsFor('/')).toEqual([]);

  resolvers.get('/')?.(loaded());
  await other;
  expect(manager.toolsFor('/')).toHaveLength(1);
  const connections = manager.connections();
  expect(connections).toHaveLength(2);
  expect(connections[0]).toMatchObject({
    serverName: 'local',
    status: 'connected',
    tools: [{ name: 'mcp__local__search', description: 'search' }],
  });
  expect(connections[1]).toMatchObject({ cwd: '/', status: 'connected' });
  await manager.close();
});

test('a failed load warns once and can be retried by a later session', async () => {
  const loader = vi
    .fn<(options: LoadMcpServerOptions) => Promise<LoadedMcpServer>>()
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce(loaded());
  const manager = new McpManager(config, [], loader);
  const warnings: string[] = [];

  await manager.start(process.cwd(), warning => warnings.push(warning));
  expect(warnings).toEqual(['MCP Server local 加载失败：boom']);
  expect(manager.toolsFor(process.cwd())).toEqual([]);

  await manager.start(process.cwd(), warning => warnings.push(warning));
  expect(warnings).toHaveLength(1);
  expect(manager.toolsFor(process.cwd())).toHaveLength(1);
  await manager.close();
});

test('a closed client is removed from subsequent tool snapshots', async () => {
  let onClose: (() => void) | undefined;
  const manager = new McpManager(config, [], async options => {
    onClose = options.onClose;
    return loaded();
  });
  await manager.start(process.cwd(), () => {});
  expect(manager.toolsFor(process.cwd())).toHaveLength(1);

  onClose?.();
  expect(manager.toolsFor(process.cwd())).toEqual([]);
  await manager.close();
});

test('rejects collisions with built-in tools', async () => {
  const warnings: string[] = [];
  const manager = new McpManager(config, ['mcp__local__search'], async () =>
    loaded(),
  );
  await manager.start(process.cwd(), warning => warnings.push(warning));
  expect(manager.toolsFor(process.cwd())).toEqual([]);
  expect(warnings[0]).toContain('工具名与已有工具冲突');
  await manager.close();
});

test('reports MCP status counts and notifies state changes', async () => {
  let resolveLoading: ((server: LoadedMcpServer) => void) | undefined;
  let closeClient: (() => void) | undefined;
  const onStatusChange = vi.fn();
  const manager = new McpManager(config, [], async options => {
    closeClient = options.onClose;
    return new Promise<LoadedMcpServer>(resolve => {
      resolveLoading = resolve;
    });
  });

  expect(manager.statusFor(process.cwd())).toEqual({
    connected: 0,
    connecting: 1,
    failed: 0,
  });
  const starting = manager.start(process.cwd(), () => {}, onStatusChange);
  expect(onStatusChange).toHaveBeenCalledTimes(1);
  // load() 在微任务里调用 loader，先等 resolver 完成注册再解除阻塞。
  await Promise.resolve();
  resolveLoading?.(loaded());
  await starting;
  expect(manager.statusFor(process.cwd())).toEqual({
    connected: 1,
    connecting: 0,
    failed: 0,
  });

  closeClient?.();
  expect(manager.statusFor(process.cwd())).toEqual({
    connected: 0,
    connecting: 0,
    failed: 1,
  });
  expect(onStatusChange).toHaveBeenCalledTimes(3);
  await manager.close();
});
