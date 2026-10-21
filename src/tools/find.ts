import { access, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as z from 'zod';
import { resolvePath } from '../utils/paths.ts';
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
} from '../utils/truncate.ts';
import { runRipgrep } from './ripgrep.ts';
import { defineTool } from './schema.ts';
import type { ToolContext, ToolResult } from './types.ts';

const DEFAULT_LIMIT = 1000;

const findInputSchema = z.object({
  pattern: z.string().min(1).meta({
    description:
      'fd-style glob pattern. Patterns without "/" match basenames; patterns with "/" match paths relative to the search directory.',
  }),
  path: z
    .string()
    .meta({
      description: 'Directory to search (optional, default ".")',
    })
    .optional(),
  limit: z
    .number()
    .int()
    .positive()
    .meta({
      description: 'Maximum number of results (optional, default 1000)',
    })
    .optional(),
});

export type FindInput = z.infer<typeof findInputSchema>;

function failure(error: string): ToolResult {
  return { success: false, output: '', error };
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

async function isInsideGitRepository(startPath: string): Promise<boolean> {
  let current = startPath;
  while (true) {
    try {
      await access(join(current, '.git'));
      return true;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return false;
      }
      current = parent;
    }
  }
}

interface RipgrepGlob {
  value: string;
  ignoreCase: boolean;
}

function toRipgrepGlob(pattern: string): RipgrepGlob {
  const ignoreCase = !/\p{Lu}/u.test(pattern);
  let value = pattern;

  // fd 的位置 glob 把开头的 !/# 当作普通字符；rg 的 -g 会解释成排除/注释。
  if (value.startsWith('!') || value.startsWith('#')) {
    value = `\\${value}`;
  }

  const hasSlash = value.includes('/');
  if (hasSlash && !value.startsWith('**/')) {
    value = `**/${value}`;
  }

  if (process.platform === 'win32') {
    value = value.replaceAll('/', '[/\\\\]');
  }

  return { value, ignoreCase };
}

function formatResultPath(searchPath: string, rawPath: string): string {
  const absolutePath = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(searchPath, rawPath);
  const relativePath = relative(searchPath, absolutePath) || '.';
  return relativePath.split(sep).join('/');
}

function errorMessage(run: Awaited<ReturnType<typeof runRipgrep>>): string {
  return (
    run.stderr.trim() ||
    run.message ||
    `rg exited with code ${run.exitCode ?? 'unknown'}`
  );
}

export const findTool = defineTool({
  name: 'find',
  description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects ignore files and includes hidden files. Output is truncated to the requested result limit (default ${DEFAULT_LIMIT}) or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
  inputSchema: findInputSchema,
  async execute(input: FindInput, context: ToolContext): Promise<ToolResult> {
    const parsed = findInputSchema.safeParse(input);
    if (!parsed.success) {
      return failure(formatValidationError(parsed.error));
    }

    const { pattern } = parsed.data;
    const limit = parsed.data.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit)) {
      return failure('limit must be a positive safe integer');
    }
    if (pattern.startsWith('/')) {
      return failure('pattern must not start with "/"');
    }
    if (context.signal?.aborted) {
      return failure('operation aborted');
    }

    const searchPath = resolvePath(parsed.data.path || '.', context.cwd, {
      stripAtPrefix: true,
      normalizeUnicodeSpaces: true,
    });

    try {
      const searchStat = await stat(searchPath);
      if (!searchStat.isDirectory()) {
        return failure(`Path is not a directory: ${searchPath}`);
      }
    } catch {
      return failure(`Path not found: ${searchPath}`);
    }

    const glob = toRipgrepGlob(pattern);
    const args = ['--no-config', '--hidden', '--files', '--color=never'];
    if (!(await isInsideGitRepository(searchPath))) {
      args.push('--no-require-git');
    }
    args.push(glob.ignoreCase ? '--iglob' : '-g', glob.value, '--', searchPath);

    const resultPaths: string[] = [];
    let run: Awaited<ReturnType<typeof runRipgrep>>;
    try {
      run = await runRipgrep({
        args,
        cwd: context.cwd,
        signal: context.signal,
        onStdoutLine(line) {
          const trimmed = line.trim();
          if (trimmed === '') {
            return true;
          }

          resultPaths.push(formatResultPath(searchPath, trimmed));
          return resultPaths.length < limit;
        },
      });
    } catch (error: unknown) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    if (run.canceled) {
      return failure('operation aborted');
    }
    if (run.timedOut) {
      return failure('find timed out');
    }

    if (resultPaths.length === 0) {
      const emptyExit = run.exitCode === 0 || run.exitCode === 1;
      if (emptyExit && run.stderr.trim() === '') {
        return { success: true, output: 'No files found matching pattern' };
      }

      return failure(errorMessage(run));
    }

    const resultLimitReached = resultPaths.length >= limit;
    const rawOutput = resultPaths.join('\n');
    const truncation = truncateHead(rawOutput, {
      maxLines: Number.MAX_SAFE_INTEGER,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    const notices: string[] = [];
    if (resultLimitReached) {
      notices.push(
        `${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`,
      );
    }
    if (truncation.truncated) {
      notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    }

    let output = truncation.content;
    if (notices.length > 0) {
      output += `\n\n[${notices.join('. ')}]`;
    }

    const metadata: Record<string, unknown> = {};
    if (truncation.truncated) {
      metadata.truncation = truncation;
    }
    if (resultLimitReached) {
      metadata.resultLimitReached = limit;
    }

    return {
      success: true,
      output,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  },
});
