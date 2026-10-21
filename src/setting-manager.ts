import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import * as z from 'zod';
import type { Runtime } from './agent/runtime.ts';

// 校验失败的错误信息全局切到中文（对进程内所有 zod schema 生效）
z.config(z.locales.zhCN());

const inputTypeSchema = z.enum(['text', 'image']);

// 模型输入类型
export type InputType = z.infer<typeof inputTypeSchema>;

// 思考档位：缺省 = 不传档，由模型默认行为决定
const reasoningLevelSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

// 元数据字段全部 optional：undefined 表示「没写」，跟随 catalog；显式写了才覆盖
const modelConfigSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  reasoning: reasoningLevelSchema.optional(),
  input: z.array(inputTypeSchema).min(1).optional(),
  maxTokens: z.int().positive().optional(),
  contextWindow: z.int().positive().optional(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

const protocolSchema = z.enum([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
]);

export type Protocol = z.infer<typeof protocolSchema>;

const providerConfigSchema = z
  .strictObject({
    name: z.string().min(1),
    type: protocolSchema,
    baseUrl: z.url({ protocol: /^https?$/ }),
    apiKey: z.string(),
    models: z.array(modelConfigSchema).min(1),
  })
  .superRefine((provider, ctx) => {
    const seen = new Set<string>();
    for (const [index, model] of provider.models.entries()) {
      if (seen.has(model.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `模型 id 重复：${model.id}`,
          path: ['models', index, 'id'],
        });
      }
      seen.add(model.id);
    }
  });

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

const settingsSchema = z
  .strictObject({
    providers: z.array(providerConfigSchema).default([]),
    // 上下文占用超过 contextWindow × compactThreshold 时触发自动压缩
    compactThreshold: z.number().min(0).max(1).default(0.8),
    // 压缩后完整保留的尾部消息预算，占 contextWindow 的比例
    compactRetainRatio: z.number().min(0).max(1).default(0.16),
  })
  .superRefine((settings, ctx) => {
    const seen = new Set<string>();
    for (const [index, provider] of settings.providers.entries()) {
      if (seen.has(provider.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `provider 名称重复：${provider.name}`,
          path: ['providers', index, 'name'],
        });
      }
      seen.add(provider.name);
    }
  });

export type Settings = z.infer<typeof settingsSchema>;

export class SettingManager {
  readonly runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  settingsPath(): string {
    return join(this.runtime.homeDir(), 'settings.jsonc');
  }

  load(): Promise<Settings> {
    return loadSettings(this.settingsPath());
  }
}

export async function loadSettings(path: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    // 没有配置文件是正常情况，用默认值
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return settingsSchema.parse({});
    }

    throw error;
  }

  const errors: ParseError[] = [];
  const data = parse(text, errors, {
    allowTrailingComma: true, // 允许尾随逗号
    allowEmptyContent: true, // 空文件视为“没有配置”，而不是报错
  }) as unknown; // parse 返回 any，立刻收敛成 unknown，不然 any 会一路漏下去

  const [firstError] = errors;
  if (firstError) {
    const { line, column } = locate(text, firstError.offset);
    throw new Error(
      `${path}:${line}:${column} 配置解析失败：${printParseErrorCode(
        firstError.error,
      )}`,
    );
  }

  // 空文件 / 纯注释文件解析结果是 undefined，按“没有配置”处理
  const result = settingsSchema.safeParse(data ?? {});
  if (!result.success) {
    throw new Error(`${path} 配置校验失败：\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}

function locate(
  text: string,
  offset: number,
): { line: number; column: number } {
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

  return { line, column };
}
