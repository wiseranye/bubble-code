import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  type WriteStream,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import type { AgentMessage } from '../llm/types.ts';

export interface SessionMeta {
  type: 'metadata';
  id: string;
  cwd: string;
  version: number;
  timestamp: number;
}

export interface BaseSessionEntry {
  type: string;
  id: string;
  timestamp: number;
}

export interface SessionMessageEntry extends BaseSessionEntry {
  type: 'message';
  message: AgentMessage;
}

export type SessionEntry = SessionMeta | SessionMessageEntry;

const CURRENT_SESSION_VERSION = 1;

function resolveHome(): string {
  const bubbleHome = process.env.BUBBLE_HOME?.trim();
  return bubbleHome ? resolve(bubbleHome) : join(homedir(), '.bubble');
}

function formatCwd(cwd: string): string {
  return `--${resolve(cwd)
    .replace(/\\/g, '/')
    .replace(/:/g, '')
    .replace(/^\/+/, '')
    .replace(/\//g, '-')}`;
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
      this._entries = this._loadEntries(sessionFile);
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

  sessionFile(): string {
    return this._sessionFile;
  }

  private _loadEntries(file: string): SessionEntry[] {
    const content = readFileSync(file, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as SessionEntry);
  }

  private _isMetadataEntry(entry: SessionEntry): entry is SessionMeta {
    return entry.type === 'metadata';
  }

  appendMessage(message: AgentMessage) {
    const entry: SessionMessageEntry = {
      type: 'message',
      message: message,
      id: uuidv7(),
      timestamp: Date.now(),
    };
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
      void new Promise<void>((resolve, reject) => {
        stream.once('finish', resolve);
        stream.once('error', reject);
      });
    }
  }
}
