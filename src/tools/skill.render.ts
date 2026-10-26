import { truncateToWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { textLines } from './block.render.ts';
import { readRenderer } from './read.render.ts';
import { summariseUnknownInput } from './summarise-input.ts';
import type { ToolRenderer, ToolRenderState } from './types.ts';

// 模型 read SKILL.md 与用户手动激活共用同一种加载记录。
// 成功时折叠态只留头部；失败仍直接展示错误，避免把失败藏进展开区。
export const skillRenderer: ToolRenderer = {
  displayName,
  summarise,
  renderBody,
  hasMoreBody,
};

function displayName(): string {
  return 'skill';
}

function summarise(input: unknown): string {
  const summary =
    readRenderer.summarise?.(input) ?? summariseUnknownInput(input);
  const name = skillName(input);
  return name === undefined ? summary : `${name} — ${summary}`;
}

function renderBody(
  state: ToolRenderState,
  ctx: { width: number; expanded: boolean },
): string[] {
  if (state.status !== 'done' || (state.success && !ctx.expanded)) {
    return [];
  }

  const lines = state.success
    ? textLines(state.output).map(line => chalk.dim(line))
    : [
        ...textLines(state.error ?? '').map(line => chalk.red(line)),
        ...textLines(state.output).map(line => chalk.dim(line)),
      ];
  return lines.map(line => truncateToWidth(line, ctx.width));
}

function hasMoreBody(state: ToolRenderState): boolean {
  return (
    state.status === 'done' &&
    state.success &&
    textLines(state.output).length > 0
  );
}

function skillName(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('skillName' in input)) {
    return undefined;
  }

  const value = input.skillName;
  return typeof value === 'string' ? value : undefined;
}
