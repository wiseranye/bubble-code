import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import { homedir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import * as z from 'zod';
import type { AgentMessage } from '../llm/types.ts';

const SessionMetaSchema = z.object({
  type: z.literal('metadata'),
  id: z.string(),
  cwd: z.string(),
  version: z.number(),
  timestamp: z.number(),
});

export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export interface BaseSessionEntry {
  type: string;
  id: string;
  timestamp: number;
}

export interface SessionMessageEntry extends BaseSessionEntry {
  type: 'message';
  message: AgentMessage;
}

// 压缩条目：追加在文件尾部，标记一次已完成的压缩。
// firstRetainedEntryId 指向保留区间的第一条消息条目，恢复时据此重建上下文
export interface SessionCompactionEntry extends BaseSessionEntry {
  type: 'compaction';
  summary: string;
  summarizedCount: number;
  firstRetainedEntryId: string;
}

export type SessionEntry =
  | SessionMeta
  | SessionMessageEntry
  | SessionCompactionEntry;

export interface SessionFileEntry {
  id: string;
  cwd: string;
  title: string;
  version: number;
  timestamp: number;
  filePath: string;
}

const CURRENT_SESSION_VERSION = 1;

function resolveHome(): string {
  const appHome = process.env.BUBBLE_HOME?.trim();
  return appHome ? resolve(appHome) : join(homedir(), '.bubble');
}

function formatCwd(cwd: string): string {
  return `--${resolve(cwd)
    .replace(/\\/g, '/')
    .replace(/:/g, '')
    .replace(/^\/+/, '')
    .replace(/\//g, '-')}`;
}

function loadSessionEntries(filePath: string): SessionEntry[] {
  const content = readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as SessionEntry);
}

function readMetadataEntry(filePath: string): SessionMeta | undefined {
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.alloc(1024);
  let result = '';
  try {
    // 只需要第一行（metadata），读到第一个换行就停
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }

      const chunk = buffer.toString('utf8', 0, bytesRead);
      const newlineIndex = chunk.indexOf('\n');
      if (newlineIndex !== -1) {
        result += chunk.slice(0, newlineIndex);
        break;
      }

      result += chunk;
    }
  } finally {
    closeSync(fd);
  }

  try {
    const entry: unknown = JSON.parse(result.replace(/\r$/, ''));
    const parsed = SessionMetaSchema.safeParse(entry);
    if (!parsed.success) {
      return undefined;
    }
    return parsed.data;
  } catch (error: unknown) {
    console.error(`parse session file entry failed: ${error}`);
    return undefined;
  }
}

// 标题的最大长度，超出部分截断
const maxTitleLength = 60;

// 会话标题取第一条用户消息。用户消息一般是文件第 2 行，分块读、找到即停，不读全文件
function readSessionTitle(filePath: string): string | undefined {
  const fd = openSync(filePath, 'r');
  try {
    let rest = '';
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        return undefined;
      }

      rest += buffer.toString('utf8', 0, bytesRead);
      let newlineIndex = rest.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = rest.slice(0, newlineIndex);
        rest = rest.slice(newlineIndex + 1);
        const title = parseTitleLine(line);
        if (title !== undefined) {
          return title;
        }

        newlineIndex = rest.indexOf('\n');
      }
    }
  } finally {
    closeSync(fd);
  }
}

function parseTitleLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '') {
    return undefined;
  }

  let entry: SessionEntry;
  try {
    entry = JSON.parse(trimmed) as SessionEntry;
  } catch {
    return undefined;
  }

  if (entry.type === 'message' && entry.message.role === 'user') {
    // 压成单行，过长截断
    const oneLine = entry.message.content.replace(/\s+/g, ' ').trim();
    return oneLine.length > maxTitleLength
      ? `${oneLine.slice(0, maxTitleLength)}…`
      : oneLine;
  }

  return undefined;
}

// 加载给定工作目录的所有历史会话，按时间倒序（最近的在前）
export function loadSessionFileEntries(cwd: string): SessionFileEntry[] {
  const appHome = resolveHome();
  const sessionDir = `${appHome}/sessions/${formatCwd(cwd)}`;
  if (!existsSync(sessionDir) || !statSync(sessionDir).isDirectory()) {
    // 如果目标目录不是一个文件夹，我们把报错留到写入的地方
    return [];
  }
  const entries = readdirSync(sessionDir, { withFileTypes: true });

  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => {
      const filePath = path.join(sessionDir, entry.name);
      const metadata = readMetadataEntry(filePath);
      if (!metadata) {
        return undefined;
      } else {
        return {
          id: metadata.id,
          cwd: metadata.cwd,
          version: metadata.version,
          // 没有用户消息（比如刚创建就退出）时退回会话 id
          title: readSessionTitle(filePath) ?? metadata.id,
          timestamp: metadata.timestamp,
          filePath: filePath,
        } as SessionFileEntry;
      }
    })
    .filter(entry => entry !== undefined)
    .sort((a, b) => b.timestamp - a.timestamp);
}

export class SessionManager {
  private readonly _id: string;
  private readonly _entries: SessionEntry[];

  private readonly _cwd: string;
  private readonly _sessionDir: string;
  private readonly _sessionFile: string;

  private _writeQueue: Promise<void> = Promise.resolve();
  private _writeStream?: WriteStream;

  constructor(cwd: string, sessionFile?: string) {
    this._cwd = cwd;
    if (sessionFile) {
      this._entries = loadSessionEntries(sessionFile);
      this._sessionDir = dirname(sessionFile);
      this._sessionFile = sessionFile;
      // resolve session id
      if (this._entries.length < 1) {
        throw new Error('not a valid session file');
      }
      const firstEntry = this._entries[0];
      if (this._isMetadataEntry(firstEntry!)) {
        this._id = firstEntry.id;
      } else {
        throw new Error(
          'not a valid session file, the first entry is not a metadata entry',
        );
      }
    } else {
      this._id = uuidv7();
      const appHome = resolveHome();
      const projectKey = formatCwd(cwd);
      this._entries = [];
      this._sessionDir = `${appHome}/sessions/${projectKey}`;
      this._sessionFile = `${this._sessionDir}/session-${this._id}.jsonl`;
    }

    mkdirSync(this._sessionDir, { recursive: true });
  }

  id(): string {
    return this._id;
  }

  cwd(): string {
    return this._cwd;
  }

  entries(): SessionEntry[] {
    return this._entries;
  }

  private _isMetadataEntry(entry: SessionEntry): entry is SessionMeta {
    return entry.type === 'metadata';
  }

  // 返回分配的条目 id：压缩需要引用保留区间第一条消息的条目 id
  appendMessage(message: AgentMessage): string {
    const entry: SessionMessageEntry = {
      type: 'message',
      message: message,
      id: uuidv7(),
      timestamp: Date.now(),
    };
    this._enqueue(entry);
    return entry.id;
  }

  // 压缩条目只记录压缩结果，摘要调用本身不进会话文件
  appendCompaction({
    summary,
    summarizedCount,
    firstRetainedEntryId,
  }: {
    summary: string;
    summarizedCount: number;
    firstRetainedEntryId: string;
  }): string {
    const entry: SessionCompactionEntry = {
      type: 'compaction',
      summary,
      summarizedCount,
      firstRetainedEntryId,
      id: uuidv7(),
      timestamp: Date.now(),
    };
    this._enqueue(entry);
    return entry.id;
  }

  private _enqueue(entry: SessionEntry): void {
    // 把这次写入挂到链尾：前一个写完才轮到它
    this._writeQueue = this._writeQueue
      .then(() => this._appendEntry(entry))
      // 错误在这里统一接住：记日志，不往外抛，也不影响后续写入
      .catch(err => console.error('session message 写入失败:', err));
  }

  private async _appendEntry(entry: SessionEntry) {
    if (this._entries.length === 0) {
      const firstEntry: SessionMeta = {
        type: 'metadata',
        id: this._id,
        cwd: this._cwd,
        version: CURRENT_SESSION_VERSION,
        timestamp: Date.now(),
      };
      this._entries.push(firstEntry);
      await this._writeFileSync(firstEntry);
    }
    this._entries.push(entry);
    await this._writeFileSync(entry);
  }

  private async _writeFileSync(record: unknown): Promise<void> {
    // lazy init write stream
    if (!this._writeStream) {
      this._writeStream = createWriteStream(this._sessionFile, {
        flags: 'a',
        encoding: 'utf-8',
      });
    }
    const line = `${JSON.stringify(record)}\n`;
    if (!this._writeStream.write(line)) {
      await new Promise<void>((resolve, reject) => {
        if (this._writeStream) {
          this._writeStream.once('drain', resolve);
          this._writeStream.once('error', reject);
        }
      });
    }
  }

  async close(): Promise<void> {
    // 等所有排队写入完成
    await this._writeQueue;
    const stream = this._writeStream;
    this._writeStream = undefined;
    if (stream) {
      stream.end();
      // 等到 finish：close 返回时数据必须已落盘，/resume 紧接着重读同一个文件依赖这一点
      await new Promise<void>((resolve, reject) => {
        stream.once('finish', resolve);
        stream.once('error', reject);
      });
    }
  }
}
