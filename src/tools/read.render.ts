import { readInputSchema } from './read-input.ts';
import { summariseUnknownInput } from './summarise-input.ts';
import type { ToolRenderer } from './types.ts';

export const readRenderer: ToolRenderer = { summarise };

export function isSkillReadInput(input: unknown): boolean {
  const parsed = readInputSchema.safeParse(input);
  if (!parsed.success) {
    return false;
  }

  const path = parsed.data.filePath.replaceAll('\\', '/');
  return path === 'SKILL.md' || path.endsWith('/SKILL.md');
}

// → src/app.ts
// → src/app.ts（第 10 行起，共 20 行）
// → src/app.ts（从第 10 行起）
// → src/app.ts（前 20 行）
function summarise(input: unknown): string {
  const parsed = readInputSchema.safeParse(input);
  if (!parsed.success) {
    return summariseUnknownInput(input);
  }

  const { filePath, offset, limit } = parsed.data;
  if (offset !== undefined && limit !== undefined) {
    return `${filePath}（第 ${offset} 行起，共 ${limit} 行）`;
  }

  if (offset !== undefined) {
    return `${filePath}（从第 ${offset} 行起）`;
  }

  if (limit !== undefined) {
    return `${filePath}（前 ${limit} 行）`;
  }

  return filePath;
}
