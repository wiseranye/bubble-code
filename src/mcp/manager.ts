import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AnyTool } from '../tools/types.ts';
import type { McpConfig, McpServerConfig } from './config.ts';
import {
  type LoadedMcpServer,
  type LoadMcpServerOptions,
  loadMcpServer,
} from './loader.ts';

const loadTimeoutMs = 10_000;
const closeTimeoutMs = 5_000;

type McpServerLoader = (
  options: LoadMcpServerOptions,
) => Promise<LoadedMcpServer>;

export type McpStatus = {
  connected: number;
  connecting: number;
  failed: number;
};

export type McpConnection = {
  serverName: string;
  cwd: string;
  status: 'connected' | 'connecting' | 'failed';
  tools: readonly { name: string; description: string }[];
  error?: string;
};

type McpEntry = {
  readonly serverName: string;
  readonly cwd: string;
  readonly controller: AbortController;
  readonly onStatusChange: () => void;
  status: 'loading' | 'ready' | 'failed';
  promise?: Promise<void>;
  loaded?: LoadedMcpServer;
  error?: string;
};

export class McpManager {
  private readonly config: McpConfig;
  private readonly reservedToolNames: ReadonlySet<string>;
  private readonly loader: McpServerLoader;
  private readonly entries = new Map<string, Map<string, McpEntry>>();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    config: McpConfig,
    reservedToolNames: Iterable<string> = [],
    loader: McpServerLoader = loadMcpServer,
  ) {
    this.config = config;
    this.reservedToolNames = new Set(reservedToolNames);
    this.loader = loader;
  }

  async start(
    cwd: string,
    warn: (content: string) => void,
    onStatusChange: () => void = () => {},
  ): Promise<void> {
    const normalizedCwd = normalizeCwd(cwd);
    if (this.closing) {
      return;
    }

    const attempts: Promise<void>[] = [];
    for (const [serverName, config] of Object.entries(this.config.mcpServers)) {
      const existing = this.entries.get(normalizedCwd)?.get(serverName);
      if (existing?.status === 'loading' || existing?.status === 'ready') {
        continue;
      }

      const entry: McpEntry = {
        serverName,
        cwd: normalizedCwd,
        controller: new AbortController(),
        onStatusChange,
        status: 'loading',
      };
      let byServer = this.entries.get(normalizedCwd);
      if (byServer === undefined) {
        byServer = new Map();
        this.entries.set(normalizedCwd, byServer);
      }
      byServer.set(serverName, entry);
      onStatusChange();
      entry.promise = this.load(entry, config);
      attempts.push(
        entry.promise.then(() => {
          if (entry.status === 'failed' && !this.closing) {
            warn(
              `MCP Server ${serverName} 加载失败：${entry.error ?? '未知错误'}`,
            );
          }
        }),
      );
    }
    await Promise.all(attempts);
  }

  toolsFor(cwd: string): AnyTool[] {
    if (this.closing) {
      return [];
    }
    const byServer = this.entries.get(normalizeCwd(cwd));
    if (byServer === undefined) {
      return [];
    }
    return [...byServer.values()].flatMap(entry =>
      entry.status === 'ready' ? (entry.loaded?.tools ?? []) : [],
    );
  }

  statusFor(cwd: string): McpStatus | undefined {
    const total = Object.keys(this.config.mcpServers).length;
    if (total === 0) {
      return undefined;
    }

    const byServer = this.entries.get(normalizeCwd(cwd));
    const status: McpStatus = { connected: 0, connecting: 0, failed: 0 };
    for (const serverName of Object.keys(this.config.mcpServers)) {
      const entry = byServer?.get(serverName);
      if (entry === undefined || entry.status === 'loading') {
        status.connecting++;
      } else if (entry.status === 'ready') {
        status.connected++;
      } else {
        status.failed++;
      }
    }
    return status;
  }

  connections(): McpConnection[] {
    return [...this.entries.values()].flatMap(byServer =>
      [...byServer.values()].map(entry => ({
        serverName: entry.serverName,
        cwd: entry.cwd,
        status:
          entry.status === 'ready'
            ? 'connected'
            : entry.status === 'loading'
              ? 'connecting'
              : 'failed',
        tools:
          entry.status === 'ready'
            ? (entry.loaded?.tools ?? []).map(tool => ({
                name: tool.name,
                description: tool.description,
              }))
            : [],
        ...(entry.error === undefined ? {} : { error: entry.error }),
      })),
    );
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closing = true;
    const entries = [...this.entries.values()].flatMap(byServer => [
      ...byServer.values(),
    ]);
    for (const entry of entries) {
      if (entry.status === 'loading') {
        entry.controller.abort();
      }
    }

    const work = async (): Promise<void> => {
      await Promise.all(
        entries.map(entry => entry.promise ?? Promise.resolve()),
      );
      await Promise.all(
        entries.map(async entry => {
          await entry.loaded?.close().catch(() => {});
          entry.loaded = undefined;
          entry.status = 'failed';
        }),
      );
    };
    this.closePromise = withTimeout(work(), closeTimeoutMs);
    return this.closePromise;
  }

  private async load(entry: McpEntry, config: McpServerConfig): Promise<void> {
    const timer = setTimeout(() => entry.controller.abort(), loadTimeoutMs);
    timer.unref();
    const loading = Promise.resolve().then(() =>
      this.loader({
        serverName: entry.serverName,
        config,
        cwd: entry.cwd,
        signal: entry.controller.signal,
        onClose: () => this.handleClose(entry),
      }),
    );

    try {
      const loaded = await raceWithAbort(loading, entry.controller.signal);
      if (this.closing || entry.controller.signal.aborted) {
        await loaded.close().catch(() => {});
        return;
      }
      const conflict = this.findConflict(entry, loaded.tools);
      if (conflict !== undefined) {
        await loaded.close().catch(() => {});
        throw new Error(`工具名与已有工具冲突：${conflict}`);
      }
      entry.loaded = loaded;
      entry.status = 'ready';
    } catch (error: unknown) {
      entry.status = 'failed';
      entry.error = entry.controller.signal.aborted
        ? '加载超时（10 秒）'
        : error instanceof Error
          ? error.message
          : String(error);
      if (entry.controller.signal.aborted) {
        void loading
          .then(async loaded => loaded.close().catch(() => {}))
          .catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      entry.onStatusChange();
    }
  }

  private findConflict(
    entry: McpEntry,
    tools: readonly AnyTool[],
  ): string | undefined {
    for (const tool of tools) {
      if (this.reservedToolNames.has(tool.name)) {
        return tool.name;
      }
      for (const [cwd, byServer] of this.entries) {
        if (cwd !== entry.cwd) {
          continue;
        }
        for (const other of byServer.values()) {
          if (
            other !== entry &&
            other.status === 'ready' &&
            other.loaded?.tools.some(candidate => candidate.name === tool.name)
          ) {
            return tool.name;
          }
        }
      }
    }
    return undefined;
  }

  private handleClose(entry: McpEntry): void {
    if (this.entries.get(entry.cwd)?.get(entry.serverName) !== entry) {
      return;
    }
    if (entry.status === 'ready') {
      entry.loaded = undefined;
      entry.status = 'failed';
      entry.error = '连接已关闭';
      entry.onStatusChange();
    }
  }
}

function normalizeCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function withTimeout(
  promise: Promise<void>,
  timeout: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeout);
    timer.unref();
  });
  await Promise.race([promise, expired]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}
