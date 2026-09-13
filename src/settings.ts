import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import process from 'node:process';
import {parse, printParseErrorCode, type ParseError} from 'jsonc-parser';

// 模型定义
export type ModelDef = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: InputType[];
  maxTokens?: number;
  contextWindow?: number;
};

// 模型输入类型
export type InputType = 'text' | 'image';

// 协议
export type Protocol = 'openai-compatible';

export type Provider = {
  name: string;
  type: Protocol;
  baseUrl: string;
  apiKey: string;
  models: ModelDef[];
};

export type Settings = {
  providers: Provider[];
};

const defaults: Settings = {providers: []};

export async function loadSettings(): Promise<Settings> {
  // 解析配置文件路径
  const path = resolveSettingsPath();
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    // 没有配置文件是正常情况，用默认值
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaults;
    }

    throw error;
  }

  const errors: ParseError[] = [];
  const data = parse(text, errors, {
    allowEmptyContent: true, // 允许尾随逗号
    allowTrailingComma: true, // 空文件视为“没有配置”，而不是报错
  }) as unknown; // Parse 返回 any，立刻收敛成 unknown，不然 any 会一路漏下去

  const [firstError] = errors;
  if (firstError) {
    const {line, column} = locate(text, firstError.offset);
    throw new Error(
      `${path}:${line}:${column} 配置解析失败：${printParseErrorCode(
        firstError.error,
      )}`,
    );
  }

  return validateSettings(data, path);
}

function locate(text: string, offset: number): {line: number; column: number} {
  let line = 1;
  let column = 1;

  for (let index = 0; index < offset; index++) {
    if (text[index] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  return {line, column};
}

export function validateSettings(data: unknown, path: string): Settings {
  if (!isSettings(data)) {
    throw new Error(`${path}: 顶层缺少 providers 数组`);
  }

  return data; // 走到这里 data 已经是 Settings
}

// --------------- 类型守卫 --------------- //

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is Provider {
  if (!isRecord(value)) {
    return false;
  }

  const {name} = value;
  return typeof name === 'string';
}

function isSettings(value: unknown): value is Settings {
  if (!isRecord(value)) {
    return false;
  }

  const {providers} = value;
  return (
    Array.isArray(providers) && providers.every(value => isProvider(value))
  );
}

// --------------- 路径解析 --------------- //

// 各平台统一：XDG_CONFIG_HOME（绝对路径时优先）→ ~/.config
function configDirectory(): string {
  // TSConfig 的 noPropertyAccessFromIndexSignature 要求索引签名用方括号
  // eslint-disable-next-line @typescript-eslint/dot-notation
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg && isAbsolute(xdg)) {
    return xdg;
  }

  return join(homedir(), '.config');
}

function resolveSettingsPath(): string {
  return join(configDirectory(), 'bubble', 'settings.jsonc');
}
