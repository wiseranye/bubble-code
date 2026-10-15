import { readFile, writeFile } from 'node:fs/promises';
import { resolvePath } from '../utils/paths.ts';
import { splitBom } from '../utils/text.ts';
import { editRenderer } from './edit.render.ts';
import {
  applyReplacements,
  applyReplacementsPreservingUnchangedLines,
  detectLineEnding,
  findText,
  locateMatch,
  normalizeToLF,
  restoreLineEndings,
  type TextReplacement,
} from './edit-diff.ts';
import { type EditInput, editInputSchema } from './edit-input.ts';
import { defineTool } from './schema.ts';
import type { ToolContext, ToolResult } from './types.ts';

function failure(error: string): ToolResult {
  return { success: false, output: '', error };
}

export const editTool = defineTool({
  name: 'edit',
  description: 'Edit an existing UTF-8 text file by replacing literal text.',
  inputSchema: editInputSchema,
  render: editRenderer,
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
      const buffer = await readFile(absolutePath);
      rawContent = buffer.toString('utf8');
      // 非法字节会被解码成 U+FFFD，整体重写将静默损坏非 UTF-8 文件：编码回字节与原 buffer 比对，不一致即拒绝
      if (!Buffer.from(rawContent, 'utf8').equals(buffer)) {
        return failure(
          `File is not valid UTF-8: ${input.filePath}. It may be binary or use another encoding; edit refused to avoid corrupting it.`,
        );
      }
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return failure(`File not found: ${input.filePath}`);
      }

      // 权限不足（EACCES）、是目录（EISDIR）等：标注阶段，方便模型纠正
      return failure(
        `Failed to read ${input.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      return failure(
        `Failed to write ${input.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const replaced = indices.length;
    const fuzzyNote = match.usedFuzzyMatch ? ' (fuzzy match)' : '';
    // replaceAll 时 diff 只展示第一处改动（indices 按出现顺序排列）
    const located = locateMatch(
      match.contentForReplacement,
      indices[0]!,
      match.matchLength,
    );
    return {
      success: true,
      output: `Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} in ${input.filePath}${fuzzyNote}`,
      metadata: {
        diff: {
          filePath: input.filePath,
          oldText: located.text,
          newText,
          startLine: located.startLine,
          fuzzy: match.usedFuzzyMatch,
        },
      },
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
