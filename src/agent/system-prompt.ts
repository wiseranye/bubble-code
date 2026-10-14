import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import type { ToolRegistry } from '../tools/types.ts';
import { stripBom } from '../utils/text.ts';

const IDENTITY = `你是 Bubble Code，一个运行在命令行中的交互式编码助手。
回答简洁，先给结论再给细节。
回答问题前先保证有了足够的信息，不要凭空猜测。`;

export function buildSystemPrompt(registry: ToolRegistry): string {
  const sections: string[] = [IDENTITY];
  // tools
  const toolSpec = registry
    .list()
    .map(tool => `- ${tool.name}: ${tool.description}`)
    .join('\n');
  sections.push(wrapXmlTag('tools', toolSpec));
  // AGENTS.md
  const context = loadProjectContext(process.cwd());
  if (context) {
    const instructions = `项目特定的指令和规范：
<instructions path="${context.filePath}">
${context.content}
</instructions>`;
    sections.push(wrapXmlTag('project_context', instructions));
  }
  // current working directory
  sections.push(wrapXmlTag('cwd', process.cwd()));
  return sections.join('\n\n');
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
