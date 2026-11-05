import { readFile } from 'node:fs/promises';
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import * as z from 'zod';

const serverNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'Server 名称格式不正确');

const stdioServerSchema = z.strictObject({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

const remoteServerSchema = z.strictObject({
  type: z.literal('remote'),
  url: z.url({ protocol: /^https?$/ }),
  headers: z.record(z.string(), z.string()).default({}),
});

const mcpConfigSchema = z.strictObject({
  mcpServers: z
    .record(serverNameSchema, z.union([stdioServerSchema, remoteServerSchema]))
    .default({}),
});

export type McpServerConfig = z.infer<
  typeof stdioServerSchema | typeof remoteServerSchema
>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

export async function loadMcpConfig(path: string): Promise<McpConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return mcpConfigSchema.parse({});
    }
    throw error;
  }

  const errors: ParseError[] = [];
  const data = parse(text, errors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
  }) as unknown;
  const [firstError] = errors;
  if (firstError) {
    const { line, column } = locate(text, firstError.offset);
    throw new Error(
      `${path}:${line}:${column} 配置解析失败：${printParseErrorCode(firstError.error)}`,
    );
  }

  const result = mcpConfigSchema.safeParse(data ?? {});
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
