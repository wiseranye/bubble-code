import chalk from 'chalk';
import {
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
} from '@earendil-works/pi-tui';

// 消息标记与文本的颜色，和旧 Ink 主题保持一致
export const style = {
  userMark: (text: string) => chalk.bold.cyan(text),
  assistantMark: (text: string) => chalk.bold.green(text),
  system: (text: string) => chalk.gray(text),
  toolMark: (text: string, failed: boolean) =>
    failed ? chalk.bold.red(text) : chalk.bold.yellow(text),
  toolName: (text: string, failed: boolean) =>
    failed ? chalk.bold.red(text) : chalk.bold.yellow(text),
  dim: (text: string) => chalk.dim(text),
  running: (text: string) => chalk.yellow(text),
};

const selectListTheme: SelectListTheme = {
  selectedPrefix: text => chalk.cyan(text),
  selectedText: text => chalk.bold(text),
  description: text => chalk.dim(text),
  scrollInfo: text => chalk.dim(text),
  noMatch: text => chalk.dim(text),
};

export const editorTheme: EditorTheme = {
  borderColor: text => chalk.gray(text),
  selectList: selectListTheme,
};

// Markdown 主题。代码块由 code-block.ts 自己渲染（上下横线分隔），
// 这里的 codeBlock / codeBlockBorder 只是满足类型，不会走到。
export function createMarkdownTheme(): MarkdownTheme {
  return {
    heading: text => chalk.bold.cyanBright(text),
    link: text => chalk.underline.blue(text),
    linkUrl: text => chalk.dim(text),
    code: text => chalk.cyan(text),
    codeBlock: text => text,
    codeBlockBorder: text => chalk.dim(text),
    quote: text => text,
    quoteBorder: text => chalk.dim(text),
    hr: text => chalk.dim(text),
    listBullet: text => text,
    bold: text => chalk.bold(text),
    italic: text => chalk.italic(text),
    strikethrough: text => chalk.strikethrough(text),
    underline: text => chalk.underline(text),
  };
}
