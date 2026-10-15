import { truncateToWidth } from '@earendil-works/pi-tui';
import {
  collapsedBodyLines,
  previewHidesContent,
} from '../tools/block.render.ts';
import { summariseUnknownInput } from '../tools/summarise-input.ts';
import type { ToolRenderer, ToolRenderState } from '../tools/types.ts';
import { style } from './theme.ts';

// 兜底渲染器：工具没有自带 render、或自带 render 缺某个插槽时用它。
// 正文由渲染器自己收窄到 ctx.width，调用方只负责左侧标记列的缩进
export const defaultToolRenderer: ToolRenderer = {
  summarise: summariseToolInput,
  renderBody: renderToolBody,
  hasMoreBody: hasMoreToolBody,
};

// 参数压成一行：单个字段只显示值，其余原样显示 JSON
export function summariseToolInput(input: unknown): string {
  return summariseUnknownInput(input);
}

export function renderToolBody(
  state: ToolRenderState,
  ctx: { width: number; expanded: boolean },
): string[] {
  if (state.status !== 'done') {
    return [];
  }

  // 失败时错误在前、输出在后，颜色区分；成功的正文统一暗色
  const lines = state.success
    ? textLines(state.output).map(line => style.dim(line))
    : [
        ...textLines(state.error ?? '').map(line => style.error(line)),
        ...textLines(state.output).map(line => style.dim(line)),
      ];
  const shown = ctx.expanded ? lines : capLines(lines);
  return shown.map(line => truncateToWidth(line, ctx.width));
}

// 展开能看到更多行：通用正文超过折叠预算
export function hasMoreToolBody(state: ToolRenderState): boolean {
  if (state.status !== 'done') {
    return false;
  }

  // 失败时错误在前，行数是两段之和
  const rows = state.success
    ? textLines(state.output).length
    : textLines(state.error ?? '').length + textLines(state.output).length;
  return previewHidesContent(rows);
}

// 折叠时只留头部若干行，其余折成一行提示
function capLines(lines: string[]): string[] {
  if (lines.length <= collapsedBodyLines) {
    return lines;
  }

  return [
    ...lines.slice(0, collapsedBodyLines),
    style.dim(`… 还有 ${lines.length - collapsedBodyLines} 行，点击展开`),
  ];
}

function textLines(text: string): string[] {
  const body = text.replace(/\n+$/, '');
  return body === '' ? [] : body.split('\n');
}
