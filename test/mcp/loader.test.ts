import { expect, test } from 'vitest';
import { loadMcpServer } from '../../src/mcp/loader.ts';

test('redacts longer secrets before their overlapping prefixes', async () => {
  const message = await loadMcpServer({
    serverName: 'local',
    config: {
      type: 'stdio',
      command: process.execPath,
      args: ['-e', 'console.error(process.env.LONG); process.exit(1)'],
      env: { SHORT: 'abc', LONG: 'abc-supersecret' },
    },
    cwd: process.cwd(),
    signal: new AbortController().signal,
    onClose: () => {},
  }).then(
    () => {
      throw new Error('expected MCP loading to fail');
    },
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );

  expect(message).toContain('[redacted]');
  expect(message).not.toContain('supersecret');
}, 15_000);
