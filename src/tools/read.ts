import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import Type, { type Static } from 'typebox';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  utf8ByteLength,
} from '../utils/truncate.ts';
import type { Tool, ToolResult } from './types.ts';

export const readInputSchema = Type.Object({
  filePath: Type.String({
    description: '文件路径（相对当前工作目录的路径/绝对路径）',
  }),
  limit: Type.Optional(
    Type.Number({
      description:
        '最大读取行数,不传则读所有;如果传了 offset 没传 limit 则读取从 offset 开始的所有行',
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description: '读取的起始行数（从 1 开始），不传则默认从第一行开始读',
    }),
  ),
});

export type ReadInput = Static<typeof readInputSchema>;

type ReadLinesResult = {
  lines: string[];
  // 返回的行之后文件是否还有内容（有 limit 时多读一行探测得到；没读到的部分不算截断）
  hasMore: boolean;
};

async function readLines(
  filePath: string,
  limit?: number,
  offset: number = 1,
): Promise<ReadLinesResult> {
  if (!Number.isInteger(offset) || offset < 1) {
    throw new RangeError('offset must be a positive integer');
  }

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new RangeError('limit must be a non-negative integer');
  }

  // 有 limit 时尝试多读一行：读到了说明文件还有剩余，这行只是探测，不进结果
  const wanted = limit === undefined ? Number.POSITIVE_INFINITY : limit + 1;

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const lines: string[] = [];
  let lineNumber = 0;

  try {
    for await (const line of rl) {
      lineNumber++;

      if (lineNumber < offset) {
        continue;
      }

      if (lines.length >= wanted) {
        break;
      }

      lines.push(line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const hasMore = limit !== undefined && lines.length > limit;
  if (hasMore) {
    lines.pop();
  }

  return { lines, hasMore };
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error };
}

// 把读取结果拼成给模型看的文本；截断/未读完时附继续读取的提示
function formatOutput(
  input: ReadInput,
  { lines, hasMore }: ReadLinesResult,
): string {
  // offset 从 1 开始，就是第一行行号
  const startLine = input.offset ?? 1;

  if (lines.length === 0) {
    if (hasMore) {
      return `[Showing 0 lines (limit=${input.limit}). File has content from line ${startLine}; use a larger limit to read it.]`;
    }

    return startLine > 1
      ? `[Offset ${startLine} is beyond the end of the file]`
      : '[File is empty]';
  }

  const result = truncateHead(lines.join('\n'));

  if (result.firstLineExceedsLimit) {
    const firstLineSize = formatSize(utf8ByteLength(lines[0]!));
    return `[Line ${startLine} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLine}p' ${input.filePath} | head -c ${DEFAULT_MAX_BYTES}]`;
  }

  let output = result.content;

  if (result.truncated) {
    const endLine = startLine + result.outputLines - 1;
    // 读到文件尾时总行数可知；还有剩余（hasMore）时总行数未知，不给模型错误数字
    const totalPart = hasMore ? '' : ` of ${startLine - 1 + lines.length}`;
    const limitPart =
      result.truncatedBy === 'lines'
        ? ''
        : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
    output += `\n\n[Showing lines ${startLine}-${endLine}${totalPart}${limitPart}. Use offset=${endLine + 1} to continue.]`;
  } else if (hasMore) {
    // limit 之内、默认截断之下：输出完整但文件没完，必须告诉模型继续读
    const endLine = startLine + lines.length - 1;
    output += `\n\n[Showing lines ${startLine}-${endLine}. File has more lines; use offset=${endLine + 1} to continue.]`;
  }

  return output;
}

export const readTool: Tool<typeof readInputSchema> = {
  name: 'read',
  description: `Read the contents of a text file. output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
  inputSchema: readInputSchema,
  async execute(input: ReadInput): Promise<ToolResult> {
    try {
      const fileStat = await stat(input.filePath);
      if (fileStat.isDirectory()) {
        return failure(`Is a directory: ${input.filePath}`);
      }

      const result = await readLines(input.filePath, input.limit, input.offset);
      return { success: true, output: formatOutput(input, result) };
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return failure(`File not found: ${input.filePath}`);
      }

      // 参数非法（RangeError）、权限不足（EACCES）等：消息原样给模型，方便纠正
      return failure(error instanceof Error ? error.message : String(error));
    }
  },
};

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
