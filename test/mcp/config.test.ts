import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadMcpConfig } from '../../src/mcp/config.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function configFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bubble-mcp-'));
  dirs.push(dir);
  const path = join(dir, 'mcp.jsonc');
  writeFileSync(path, content);
  return path;
}

test('a missing MCP config loads no servers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bubble-mcp-'));
  dirs.push(dir);
  await expect(loadMcpConfig(join(dir, 'missing.jsonc'))).resolves.toEqual({
    mcpServers: {},
  });
});

test('loads stdio and remote servers with defaults', async () => {
  const config = await loadMcpConfig(
    configFile(`{
      // JSONC is supported
      "mcpServers": {
        "local": { "type": "stdio", "command": "local-mcp" },
        "remote": { "type": "remote", "url": "https://example.com/mcp" },
      },
    }`),
  );
  expect(config.mcpServers.local).toEqual({
    type: 'stdio',
    command: 'local-mcp',
    args: [],
    env: {},
  });
  expect(config.mcpServers.remote).toEqual({
    type: 'remote',
    url: 'https://example.com/mcp',
    headers: {},
  });
});

test('rejects unknown fields and invalid server names', async () => {
  await expect(
    loadMcpConfig(
      configFile('{"mcpServers":{"Bad.Name":{"type":"stdio","command":"x"}}}'),
    ),
  ).rejects.toThrow(/配置校验失败/);
  await expect(
    loadMcpConfig(
      configFile(
        '{"mcpServers":{"local":{"type":"stdio","command":"x","unknown":true}}}',
      ),
    ),
  ).rejects.toThrow(/配置校验失败/);
});
