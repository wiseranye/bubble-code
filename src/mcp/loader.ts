import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { APP_NAME, APP_VERSION } from '../app-info.ts';
import { truncateTail } from '../utils/truncate.ts';
import type { McpServerConfig } from './config.ts';
import { createMcpTools } from './tool.ts';

export interface LoadedMcpServer {
  readonly tools: ReturnType<typeof createMcpTools>;
  close(): Promise<void>;
}

export interface LoadMcpServerOptions {
  readonly serverName: string;
  readonly config: McpServerConfig;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly onClose: () => void;
}

export async function loadMcpServer(
  options: LoadMcpServerOptions,
): Promise<LoadedMcpServer> {
  const client = new Client(
    { name: APP_NAME, version: APP_VERSION },
    {
      capabilities: {},
      versionNegotiation: { mode: 'auto' },
      inputRequired: { autoFulfill: false },
      listMaxPages: 64,
    },
  );
  const { transport, remote } = createTransport(options);
  const stderr = captureStderr(transport);
  client.onclose = options.onClose;

  try {
    await client.connect(transport, {
      signal: options.signal,
      timeout: 10_000,
    });
    const { tools } = await client.listTools(undefined, {
      signal: options.signal,
      timeout: 10_000,
      cacheMode: 'refresh',
    });

    return {
      tools: createMcpTools(options.serverName, client, tools),
      async close(): Promise<void> {
        if (remote !== undefined) {
          await remote.terminateSession().catch(() => {});
        }
        await client.close();
      },
    };
  } catch (error: unknown) {
    await client.close().catch(() => {});
    const detail = error instanceof Error ? error.message : String(error);
    const diagnostic = [detail, stderr()].filter(Boolean).join('\n');
    throw new Error(redactSecrets(diagnostic, options.config));
  }
}

function createTransport(options: LoadMcpServerOptions): {
  transport: Transport;
  remote?: StreamableHTTPClientTransport;
} {
  const { config } = options;
  if (config.type === 'remote') {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
      redirectPolicy: 'same-origin',
    });
    return { transport, remote: transport };
  }

  return {
    transport: new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: options.cwd,
      stderr: 'pipe',
    }),
  };
}

function captureStderr(transport: Transport): () => string {
  if (!(transport instanceof StdioClientTransport)) {
    return () => '';
  }

  let output = '';
  transport.stderr?.on('data', (chunk: unknown) => {
    output = truncateTail(`${output}${String(chunk)}`, {
      maxBytes: 8 * 1024,
    }).content;
  });
  return () => output.trim();
}

function redactSecrets(text: string, config: McpServerConfig): string {
  const values =
    config.type === 'remote'
      ? Object.values(config.headers)
      : Object.values(config.env);
  let redacted = text;
  const sortedValues = values
    .filter(value => value !== '')
    .sort((left, right) => right.length - left.length);
  for (const value of sortedValues) {
    redacted = redacted.replaceAll(value, '[redacted]');
  }
  return redacted;
}
