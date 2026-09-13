import chalk from 'chalk';
import {
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
} from '@earendil-works/pi-tui';
import {highlightCode, peekHighlighted} from './highlight.js';

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

// Markdown 主题。highlightCode 是同步接口：命中缓存直接返回 shiki 结果，
// 未命中先给纯文本，等异步算完再 invalidate 重绘（见 AssistantMessageView）
export function createMarkdownTheme(
  onHighlightReady?: () => void,
): MarkdownTheme {
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
    highlightCode(code, lang) {
      const highlighted = peekHighlighted(code, lang);
      if (highlighted !== undefined) {
        return highlighted;
      }

      void highlightCode(code, lang).then(() => {
        onHighlightReady?.();
      });
      return code.split('\n');
    },
  };
}
