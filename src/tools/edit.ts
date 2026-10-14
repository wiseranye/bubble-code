import { readFile, writeFile } from 'node:fs/promises';
import * as z from 'zod';
import { resolvePath } from '../utils/paths.ts';
import { splitBom } from '../utils/text.ts';
import {
  applyReplacements,
  applyReplacementsPreservingUnchangedLines,
  detectLineEnding,
  findText,
  normalizeToLF,
  restoreLineEndings,
  type TextReplacement,
} from './edit-diff.ts';
import { defineTool } from './schema.ts';
import type { ToolContext, ToolResult } from './types.ts';

// 编辑文件输入
const editInputSchema = z.object({
  filePath: z.string().meta({
    description: 'The file path to edit (relative or absolute)',
  }),
  oldText: z.string().meta({
    description:
      'Literal text to replace. Must match exactly. Line ending differences and minor unicode variants (smart quotes, dashes, trailing whitespace) are tolerated.',
  }),
  newText: z.string().meta({
    description:
      'Literal replacement text. Use an empty string to delete the match.',
  }),
  replaceAll: z.optional(
    z.boolean().meta({
      description:
        'Replace all matches. Defaults to false, oldText must appear exactly once.',
    }),
  ),
});

export type EditInput = z.infer<typeof editInputSchema>;

function failure(error: string): ToolResult {
  return { success: false, output: '', error };
}

export const editTool = defineTool({
  name: 'edit',
  description: 'Edit an existing UTF-8 text file by replacing literal text.',
  inputSchema: editInputSchema,
  async execute(input: EditInput, ctx: ToolContext): Promise<ToolResult> {
    if (input.oldText === '') {
      return failure('oldText must not be empty');
    }
    if (input.oldText === input.newText) {
      return failure('oldText and newText are identical; nothing to change');
    }

    if (ctx.signal?.aborted) {
      return failure('operation aborted');
    }

    const absolutePath = resolveFilePath(ctx.cwd, input.filePath);

    let rawContent: string;
    try {
      rawContent = await readFile(absolutePath, 'utf8');
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return failure(`File not found: ${input.filePath}`);
      }

      // 权限不足（EACCES）、是目录（EISDIR）等：消息原样给模型，方便纠正
      return failure(error instanceof Error ? error.message : String(error));
    }

    // 剥离 BOM 再匹配：模型不会在 oldText 里写不可见的 U+FEFF，写回时拼回
    const { bom, text } = splitBom(rawContent);
    // 归一化为 LF 匹配：模型给的 oldText 一般不含 \r，写回时恢复原始行尾
    const ending = detectLineEnding(text);
    const content = normalizeToLF(text);
    const oldText = normalizeToLF(input.oldText);
    const newText = normalizeToLF(input.newText);

    if (oldText === '') {
      return failure('oldText must not be empty');
    }

    const match = findText(content, oldText);
    if (!match.found) {
      return failure(
        `Could not find the text in ${input.filePath}. The oldText must match exactly including all whitespace and newlines.`,
      );
    }
    if (match.indices.length > 1 && !input.replaceAll) {
      return failure(
        `Found ${match.indices.length} occurrences of the text in ${input.filePath}. The text must be unique; provide more context to make it unique, or set replaceAll: true.`,
      );
    }

    if (ctx.signal?.aborted) {
      return failure('operation aborted');
    }

    const indices = input.replaceAll ? match.indices : [match.indices[0]!];
    const replacements: TextReplacement[] = indices.map(matchIndex => ({
      matchIndex,
      matchLength: match.matchLength,
      newText,
    }));

    // fuzzy 命中时在归一化空间做替换，再把触及的行叠回原文，未触及的行保留原始字节
    const newContent = match.usedFuzzyMatch
      ? applyReplacementsPreservingUnchangedLines(
          content,
          match.contentForReplacement,
          replacements,
        )
      : applyReplacements(content, replacements);

    if (newContent === content) {
      return failure(
        `No changes made to ${input.filePath}. The replacement produced identical content.`,
      );
    }

    try {
      await writeFile(
        absolutePath,
        bom + restoreLineEndings(newContent, ending),
        'utf8',
      );
    } catch (error: unknown) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    const replaced = indices.length;
    const fuzzyNote = match.usedFuzzyMatch ? ' (fuzzy match)' : '';
    return {
      success: true,
      output: `Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} in ${input.filePath}${fuzzyNote}`,
    };
  },
});

// 将路径解析为绝对路径
function resolveFilePath(cwd: string, filePath: string): string {
  return resolvePath(filePath, cwd, {
    normalizeUnicodeSpaces: true,
    stripAtPrefix: true,
  });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
