// 系统提示词按节装配：每节一个 provider，刷新时逐节对比指纹决定是否追加新的系统消息。
// 'construction' 节在装配器生命周期内只求值一次（比如 project_context 读盘）；
// 'per-refresh' 节每次装配都重新求值（工具列表、未来的 MCP / Skill 节）

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import type { ToolRegistry } from '../tools/types.ts';
import { stripBom } from '../utils/text.ts';

const IDENTITY = `你是 Bubble Code，一个运行在命令行中的交互式编码助手。
回答简洁，先给结论再给细节。
回答问题前先保证有了足够的信息，不要凭空猜测。`;

export interface PromptSectionContext {
  tools: ToolRegistry;
  cwd: string;
}

export interface PromptSectionProvider {
  readonly name: string;
  readonly freshness: 'construction' | 'per-refresh';
  // 返回 undefined 表示该节不出现（比如项目里没有 AGENTS.md）
  build(context: PromptSectionContext): string | undefined;
}

export interface BuiltSystemPrompt {
  content: string;
  // 节名 → 内容指纹：随系统消息落盘，作为下次刷新的对比基线
  sections: Record<string, string>;
}

export class SystemPromptAssembler {
  private readonly context: PromptSectionContext;
  private readonly providers: readonly PromptSectionProvider[];
  private readonly constructionCache = new Map<string, string | undefined>();

  constructor(
    context: PromptSectionContext,
    extraProviders: readonly PromptSectionProvider[] = [],
  ) {
    this.context = context;
    this.providers = [...builtinSectionProviders(), ...extraProviders];
  }

  build(): BuiltSystemPrompt {
    const parts: string[] = [];
    const sections: Record<string, string> = {};
    for (const provider of this.providers) {
      const content =
        provider.freshness === 'construction'
          ? this.buildConstruction(provider)
          : provider.build(this.context);
      if (content === undefined) {
        continue;
      }
      parts.push(content);
      sections[provider.name] = fingerprint(content);
    }
    return { content: parts.join('\n\n'), sections };
  }

  private buildConstruction(
    provider: PromptSectionProvider,
  ): string | undefined {
    if (!this.constructionCache.has(provider.name)) {
      this.constructionCache.set(provider.name, provider.build(this.context));
    }
    return this.constructionCache.get(provider.name);
  }
}

function builtinSectionProviders(): PromptSectionProvider[] {
  return [
    { name: 'identity', freshness: 'construction', build: () => IDENTITY },
    {
      name: 'tools',
      freshness: 'per-refresh',
      build: context =>
        wrapXmlTag(
          'tools',
          context.tools
            .list()
            .map(tool => `- ${tool.name}: ${tool.description}`)
            .join('\n'),
        ),
    },
    {
      name: 'project_context',
      freshness: 'construction',
      build: context => {
        const projectContext = loadProjectContext(context.cwd);
        if (projectContext === null) {
          return undefined;
        }
        return wrapXmlTag(
          'project_context',
          `项目特定的指令和规范：
<instructions path="${projectContext.filePath}">
${projectContext.content}
</instructions>`,
        );
      },
    },
    {
      name: 'cwd',
      freshness: 'construction',
      build: context => wrapXmlTag('cwd', context.cwd),
    },
  ];
}

function fingerprint(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function wrapXmlTag(tag: string, content: string): string {
  return `<${tag}>\n${content.trim()}\n</${tag}>`;
}

// AGENTS.md
function loadProjectContext(
  dir: string,
): { filePath: string; content: string } | null {
  const candidates = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];
  for (const filename of candidates) {
    const filePath = join(dir, filename);
    try {
      if (!statSync(filePath).isFile()) {
        continue;
      }
      return {
        filePath,
        content: stripBom(readFileSync(filePath, 'utf-8')),
      };
    } catch (error: unknown) {
      // 文件不存在时继续尝试下一个候选，其他错误（如权限）给出警告
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      console.error(
        chalk.yellow(`Warning: Could not read ${filePath}: ${error}`),
      );
    }
  }
  return null;
}
