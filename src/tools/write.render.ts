import chalk from 'chalk';
import {
  assembleBody,
  type BodyPart,
  blockRow,
  contextColor,
  failureLines,
  gutterColumnWidth,
  gutterPrefix,
  mutedColor,
  previewHidesContent,
  textLines,
} from './block.render.ts';
import { summariseUnknownInput } from './summarise-input.ts';
import type { ToolRenderer, ToolRenderState } from './types.ts';
import { writeInputSchema } from './write-input.ts';

type DoneState = {
  input: unknown;
  output: string;
  error?: string;
  success: boolean;
};

export const writeRenderer: ToolRenderer = {
  summarise,
  renderBody,
  hasMoreBody,
};

// → a.txt (2 行)
function summarise(input: unknown): string {
  const parsed = writeInputSchema.safeParse(input);
  if (!parsed.success) {
    return summariseUnknownInput(input);
  }

  return `${parsed.data.filePath} (${contentLines(parsed.data.content).length} 行)`;
}

function renderBody(
  state: ToolRenderState,
  ctx: { width: number; expanded: boolean },
): string[] {
  if (state.status !== 'done') {
    return [];
  }

  return assembleBody(bodyContent(state, ctx.width), ctx);
}

// 展开能看到更多行：写入的内容超过折叠预算
function hasMoreBody(state: ToolRenderState): boolean {
  if (state.status !== 'done' || !state.success) {
    return false;
  }

  const parsed = writeInputSchema.safeParse(state.input);
  if (!parsed.success) {
    // 兜底正文是工具输出，同样按预算折叠
    return previewHidesContent(textLines(state.output).length);
  }

  return previewHidesContent(contentLines(parsed.data.content).length);
}

function bodyContent(state: DoneState, width: number): BodyPart {
  if (!state.success) {
    return { lines: failureLines(state.error, state.output), block: false };
  }

  const parsed = writeInputSchema.safeParse(state.input);
  if (!parsed.success) {
    // 输入解析不出来（老会话里的异常数据）：至少把工具输出显示出来
    return {
      lines: textLines(state.output).map(line => chalk.dim(line)),
      block: false,
    };
  }

  const lines = contentLines(parsed.data.content);
  if (lines.length === 0) {
    // 空文件：没有可展示的内容，也不铺块
    return { lines: [chalk.dim('（空文件）')], block: false };
  }

  return { lines: contentBlock(lines, width), block: true };
}

// 写入内容块：行号是空格符号 + 新文件行号，正文和行号都走中性灰
function contentBlock(lines: string[], width: number): string[] {
  const columnWidth = gutterColumnWidth(lines.length);
  return lines.map((text, index) =>
    blockRow({
      gutter: gutterPrefix(' ', index + 1, columnWidth),
      content: text,
      width,
      contentColor: contextColor,
      gutterColor: mutedColor,
    }),
  );
}

// 读者看到的正文行：末尾一个换行只算行终止符，空内容没有行
function contentLines(content: string): string[] {
  if (content === '') {
    return [];
  }

  const body = content.endsWith('\n') ? content.slice(0, -1) : content;
  return body.split('\n');
}
