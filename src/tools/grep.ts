import { stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import * as z from 'zod';
import { resolvePath } from '../utils/paths.ts';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateLine,
  utf8ByteLength,
} from '../utils/truncate.ts';
import { runRipgrep } from './ripgrep.ts';
import { defineTool } from './schema.ts';
import type { ToolContext, ToolResult } from './types.ts';

const DEFAULT_LIMIT = 100;
const SEARCH_TIMEOUT = 30_000;

const grepInputSchema = z.object({
  glob: z
    .string()
    .min(1)
    .meta({
      description:
        'Optional file glob using ripgrep syntax. Only files matching it are searched.',
    })
    .optional(),
  pattern: z.string().min(1).meta({
    description: 'Rust regular expression to search for',
  }),
  path: z
    .string()
    .meta({
      description: 'File or directory to search (optional, default ".")',
    })
    .optional(),
  ignoreCase: z
    .boolean()
    .meta({
      description:
        'Case-insensitive content matching (optional, default false)',
    })
    .optional(),
  context: z
    .number()
    .int()
    .nonnegative()
    .meta({
      description:
        'Number of lines before and after each match (optional, default 0)',
    })
    .optional(),
  limit: z
    .number()
    .int()
    .positive()
    .meta({
      description: 'Maximum number of matching lines (optional, default 100)',
    })
    .optional(),
});

export type GrepInput = z.infer<typeof grepInputSchema>;

function failure(error: string, output: string = ''): ToolResult {
  return { success: false, output, error };
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeRipgrepText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.text === 'string') {
    return value.text;
  }
  if (typeof value.bytes === 'string') {
    return Buffer.from(value.bytes, 'base64').toString('utf8');
  }
  return undefined;
}

function stripLineEnding(content: string): string {
  if (content.endsWith('\r\n')) {
    return content.slice(0, -2);
  }
  if (content.endsWith('\n')) {
    return content.slice(0, -1);
  }
  return content;
}

function formatDisplayPath(rawPath: string, cwd: string): string {
  const absolutePath = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(cwd, rawPath);
  const relativePath = relative(cwd, absolutePath);
  const isInsideCwd =
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath));
  const displayPath = isInsideCwd ? relativePath || '.' : absolutePath;

  return displayPath
    .split(sep)
    .join('/')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

interface CharacterClass {
  source: string;
  nextIndex: number;
}

function parseCharacterClass(pattern: string, start: number): CharacterClass {
  let index = start + 1;
  let body = '';
  let negated = false;

  if (pattern[index] === '!' || pattern[index] === '^') {
    negated = true;
    index++;
  }

  while (index < pattern.length && pattern[index] !== ']') {
    const character = pattern[index]!;
    if (character === '\\' && index + 1 < pattern.length) {
      body += `\\${pattern[index + 1]}`;
      index += 2;
      continue;
    }
    body += character;
    index++;
  }

  if (index >= pattern.length || body === '') {
    return { source: '\\[', nextIndex: start + 1 };
  }

  return {
    source: `[${negated ? '^' : ''}${body}]`,
    nextIndex: index + 1,
  };
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  let index = 0;

  while (index < pattern.length) {
    const character = pattern[index]!;

    if (character === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) {
        source += '\\\\';
        index++;
      } else {
        source += escapeRegExp(next);
        index += 2;
      }
      continue;
    }

    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 2;
        if (pattern[index] === '/') {
          source += '(?:[^/]+/)*';
          index++;
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
        index++;
      }
      continue;
    }

    if (character === '?') {
      source += '[^/]';
      index++;
      continue;
    }

    if (character === '[') {
      const characterClass = parseCharacterClass(pattern, index);
      source += characterClass.source;
      index = characterClass.nextIndex;
      continue;
    }

    source += escapeRegExp(character);
    index++;
  }

  return new RegExp(`${source}$`);
}

function splitBraceAlternatives(body: string): string[] {
  const alternatives: string[] = [];
  let start = 0;
  let depth = 0;

  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (character === '\\') {
      index++;
      continue;
    }
    if (character === '[') {
      while (index + 1 < body.length && body[index + 1] !== ']') {
        index++;
      }
      continue;
    }
    if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
    } else if (character === ',' && depth === 0) {
      alternatives.push(body.slice(start, index));
      start = index + 1;
    }
  }

  alternatives.push(body.slice(start));
  return alternatives;
}

function expandBraces(pattern: string): string[] {
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === '\\') {
      index++;
      continue;
    }
    if (character === '[') {
      while (index + 1 < pattern.length && pattern[index + 1] !== ']') {
        index++;
      }
      continue;
    }
    if (character !== '{') {
      continue;
    }

    let depth = 1;
    for (let end = index + 1; end < pattern.length; end++) {
      const inner = pattern[end]!;
      if (inner === '\\') {
        end++;
        continue;
      }
      if (inner === '[') {
        while (end + 1 < pattern.length && pattern[end + 1] !== ']') {
          end++;
        }
        continue;
      }
      if (inner === '{') {
        depth++;
      } else if (inner === '}') {
        depth--;
        if (depth === 0) {
          const body = pattern.slice(index + 1, end);
          const alternatives = splitBraceAlternatives(body);
          if (alternatives.length === 1) {
            break;
          }

          const prefix = pattern.slice(0, index);
          const suffix = pattern.slice(end + 1);
          return alternatives.flatMap(alternative =>
            expandBraces(`${prefix}${alternative}${suffix}`),
          );
        }
      }
    }
  }

  return [pattern];
}

function trimUnescapedTrailingSpaces(pattern: string): string {
  let end = pattern.length;
  while (end > 0 && pattern[end - 1] === ' ') {
    let backslashes = 0;
    for (let index = end - 2; index >= 0 && pattern[index] === '\\'; index--) {
      backslashes++;
    }
    if (backslashes % 2 === 1) {
      break;
    }
    end--;
  }
  return pattern.slice(0, end);
}

function explicitFileMatchesGlob(glob: string, relativePath: string): boolean {
  // rg treats a leading # as a comment, leaving no active glob.
  if (glob.startsWith('#')) {
    return true;
  }

  let pattern = glob;
  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  }

  pattern = trimUnescapedTrailingSpaces(pattern);
  if (pattern.endsWith('/')) {
    return negated;
  }
  if (pattern.startsWith('/')) {
    pattern = pattern.slice(1);
  }

  const candidate = pattern.includes('/')
    ? relativePath.split(sep).join('/')
    : basename(relativePath);
  let matches = false;
  try {
    matches = expandBraces(pattern).some(expanded =>
      globToRegExp(expanded).test(candidate),
    );
  } catch {
    matches = false;
  }

  return negated ? !matches : matches;
}

function parseEvent(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(run: Awaited<ReturnType<typeof runRipgrep>>): string {
  return (
    run.stderr.trim() ||
    run.message ||
    `rg exited with code ${run.exitCode ?? 'unknown'}`
  );
}

export const grepTool = defineTool({
  name: 'grep',
  description: `Search file contents with a Rust regular expression. Returns matching lines as path:line:content and context lines as path-line-content. Results are sorted by path and line, limited to ${DEFAULT_LIMIT} matching lines by default, and truncated at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
  inputSchema: grepInputSchema,
  async execute(input: GrepInput, context: ToolContext): Promise<ToolResult> {
    const parsed = grepInputSchema.safeParse(input);
    if (!parsed.success) {
      return failure(formatValidationError(parsed.error));
    }

    const pattern = parsed.data.pattern;
    const limit = parsed.data.limit ?? DEFAULT_LIMIT;
    const contextLines = parsed.data.context ?? 0;
    const ignoreCase = parsed.data.ignoreCase ?? false;
    if (!Number.isSafeInteger(limit)) {
      return failure('limit must be a positive safe integer');
    }
    if (!Number.isSafeInteger(contextLines)) {
      return failure('context must be a non-negative safe integer');
    }
    if (context.signal?.aborted) {
      return failure('operation aborted');
    }

    const searchPath = resolvePath(parsed.data.path || '.', context.cwd, {
      stripAtPrefix: true,
      normalizeUnicodeSpaces: true,
    });

    let isDirectory: boolean;
    let isFile: boolean;
    try {
      const searchStat = await stat(searchPath);
      isDirectory = searchStat.isDirectory();
      isFile = searchStat.isFile();
    } catch {
      return failure(`Path not found: ${searchPath}`);
    }
    if (!isDirectory && !isFile) {
      return failure(`Path is not a file or directory: ${searchPath}`);
    }

    const discardMatches =
      isFile &&
      parsed.data.glob !== undefined &&
      !explicitFileMatchesGlob(
        parsed.data.glob,
        relative(resolve(searchPath, '..'), searchPath),
      );

    const args = [
      '--json',
      '--line-number',
      '--color=never',
      '--no-config',
      '--sort',
      'path',
    ];
    if (ignoreCase) {
      args.push('--ignore-case');
    }
    if (parsed.data.glob !== undefined) {
      args.push('--glob', parsed.data.glob);
    }
    if (contextLines > 0) {
      args.push('--context', String(contextLines));
    }
    args.push('--', pattern, searchPath);

    const formattedLines: string[] = [];
    let outputBytes = 0;
    let outputTruncatedBy: 'lines' | 'bytes' | null = null;
    let longLineTruncated = false;
    let matchCount = 0;
    let limitReached = false;
    let trailingPath: string | undefined;
    let trailingDeadline: number | undefined;
    let previousEntry: { rawPath: string; lineNumber: number } | undefined;

    function addEntry(
      kind: 'match' | 'context',
      rawPath: string,
      lineNumber: number,
      content: string,
    ): boolean {
      const truncated = truncateLine(content);
      const displayPath = formatDisplayPath(rawPath, context.cwd);
      const formatted =
        kind === 'match'
          ? `${displayPath}:${lineNumber}:${truncated.text}`
          : `${displayPath}-${lineNumber}-${truncated.text}`;
      const needsSeparator =
        contextLines > 0 &&
        previousEntry !== undefined &&
        (previousEntry.rawPath !== rawPath ||
          previousEntry.lineNumber + 1 !== lineNumber);
      const newLines = needsSeparator ? ['--', formatted] : [formatted];

      if (formattedLines.length + newLines.length > DEFAULT_MAX_LINES) {
        outputTruncatedBy = 'lines';
        return false;
      }

      let addedBytes = 0;
      let lineCount = formattedLines.length;
      for (const newLine of newLines) {
        addedBytes += (lineCount > 0 ? 1 : 0) + utf8ByteLength(newLine);
        lineCount++;
      }
      if (outputBytes + addedBytes > DEFAULT_MAX_BYTES) {
        outputTruncatedBy = 'bytes';
        return false;
      }

      formattedLines.push(...newLines);
      outputBytes += addedBytes;
      previousEntry = { rawPath, lineNumber };
      longLineTruncated ||= truncated.wasTruncated;
      return true;
    }

    let run: Awaited<ReturnType<typeof runRipgrep>>;
    try {
      run = await runRipgrep({
        args,
        cwd: context.cwd,
        signal: context.signal,
        timeout: SEARCH_TIMEOUT,
        onStdoutLine(line) {
          const event = parseEvent(line);
          if (event === undefined || typeof event.type !== 'string') {
            return true;
          }

          if (limitReached) {
            if (
              event.type === 'begin' ||
              event.type === 'end' ||
              event.type === 'summary'
            ) {
              return false;
            }
          } else if (event.type === 'begin' || event.type === 'end') {
            return true;
          } else if (event.type !== 'match' && event.type !== 'context') {
            return true;
          }

          if (event.type !== 'match' && event.type !== 'context') {
            return true;
          }

          const data = isRecord(event.data) ? event.data : undefined;
          const rawPath = decodeRipgrepText(data?.path);
          const rawContent = decodeRipgrepText(data?.lines);
          const lineNumber = data?.line_number;
          if (
            rawPath === undefined ||
            rawContent === undefined ||
            typeof lineNumber !== 'number' ||
            !Number.isSafeInteger(lineNumber) ||
            lineNumber < 1
          ) {
            return true;
          }
          if (discardMatches) {
            return true;
          }

          const content = stripLineEnding(rawContent);
          if (limitReached) {
            if (
              rawPath !== trailingPath ||
              trailingDeadline === undefined ||
              lineNumber > trailingDeadline
            ) {
              return false;
            }
            return addEntry('context', rawPath, lineNumber, content);
          }

          if (event.type === 'match') {
            matchCount++;
            if (matchCount >= limit) {
              limitReached = true;
              trailingPath = rawPath;
              trailingDeadline = lineNumber + contextLines;
            }
          }

          const accepted = addEntry(
            event.type === 'match' ? 'match' : 'context',
            rawPath,
            lineNumber,
            content,
          );
          if (!accepted) {
            return false;
          }
          return !(limitReached && contextLines === 0);
        },
      });
    } catch (error: unknown) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    const notices: string[] = [];
    if (longLineTruncated) {
      notices.push(
        `[Long lines truncated to ${GREP_MAX_LINE_LENGTH} characters. Use read with the reported file path and line number to view full content.]`,
      );
    }
    if (limitReached) {
      notices.push(
        `[${limit} matching lines limit reached. Use limit=${limit * 2} for more, or refine pattern]`,
      );
    }
    if (outputTruncatedBy === 'lines') {
      notices.push(
        `[${DEFAULT_MAX_LINES} output lines limit reached. Results are incomplete; refine pattern, glob, or path.]`,
      );
    } else if (outputTruncatedBy === 'bytes') {
      notices.push(
        `[${formatSize(DEFAULT_MAX_BYTES)} output limit reached. Results are incomplete; refine pattern, glob, or path.]`,
      );
    }

    let output = formattedLines.join('\n');
    if (notices.length > 0) {
      output = output
        ? `${output}\n\n${notices.join('\n')}`
        : notices.join('\n');
    }

    const intentionalStop = limitReached || outputTruncatedBy !== null;
    if (run.canceled) {
      return failure('operation aborted', output);
    }
    if (run.timedOut) {
      return failure(
        `execute timed out after ${SEARCH_TIMEOUT / 1000} seconds`,
        output,
      );
    }
    if (
      !intentionalStop &&
      (run.stderr.trim() !== '' || (run.exitCode !== 0 && run.exitCode !== 1))
    ) {
      return failure(errorMessage(run), output);
    }

    if (matchCount === 0) {
      return output === ''
        ? { success: true, output: 'No matches found.' }
        : { success: true, output };
    }

    return { success: true, output };
  },
});
