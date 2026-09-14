import {
  type Markdown,
  sliceByColumn,
  stripTerminalSequences,
  type Token,
  type Tokens,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import {highlightCode, peekHighlighted} from './highlight.js';
import {style} from './theme.js';

// Markdown.renderToken 在 pi-tui 的 .d.ts 里是 private，运行时就是普通原型方法。
// 内置代码块渲染固定输出 ``` 围栏，主题钩子去不掉；这里给实例替换渲染函数，
// 自己画上下横线分隔的块。pi-tui 升级时需要复核这一处（见测试）。
type RenderToken = (
  token: Token,
  width: number,
  nextTokenType?: string,
) => string[];

export function withCodeBlockStyle(
  markdown: Markdown,
  onHighlightReady: () => void,
): Markdown {
  const instance = markdown as unknown as {renderToken?: RenderToken};
  const original = instance.renderToken;
  if (original === undefined) {
    // PI-tui 换了实现，这里要跟着更新；宁可炸掉也不要静默渲染回围栏
    throw new TypeError('pi-tui Markdown.renderToken 接口已变化');
  }

  instance.renderToken = (token, width, nextTokenType) => {
    if (token.type !== 'code') {
      return original.call(markdown, token, width, nextTokenType);
    }

    return renderCodeBlock(
      token as Tokens.Code,
      width,
      nextTokenType,
      onHighlightReady,
    );
  };

  return markdown;
}

function renderCodeBlock(
  token: Tokens.Code,
  width: number,
  nextTokenType: string | undefined,
  onHighlightReady: () => void,
): string[] {
  const code = token.text.replace(/\n+$/, '');
  const highlighted = peekHighlighted(code, token.lang);
  if (highlighted === undefined) {
    // 同步钩子拿不到高亮结果：先用纯文本，异步算完再 invalidate 重绘
    void highlightCode(code, token.lang).then(() => {
      onHighlightReady();
    });
  }

  const lines = renderBox(highlighted ?? code.split('\n'), width, token.lang);
  // 和内置渲染一致：代码块后面补一个空行，除非下一个 token 本身就是空行
  if (nextTokenType !== undefined && nextTokenType !== 'space') {
    lines.push('');
  }

  return lines;
}

// 块的最小可用宽度：上下横线 + 语言标签至少放得下
const minBoxWidth = 8;

function renderBox(
  content: string[],
  width: number,
  lang: string | undefined,
): string[] {
  if (width < minBoxWidth) {
    return content.map(line => truncateToWidth(line, Math.max(1, width), ''));
  }

  // 只画上下两条横线，不画拐角和竖线：拐角/竖线都是会进复制内容的字符
  const lines = [style.dim(topBorder(width, lang))];
  for (const raw of content) {
    lines.push(...wrapCodeLine(raw, width));
  }

  lines.push(style.dim('─'.repeat(width)));
  return lines;
}

// 折行时保留行首缩进：wrapTextWithAnsi 会把折出来的行首空白吃掉，
// 代码里长表达式折行后就会贴到左边，看起来像超出了代码块
function wrapCodeLine(raw: string, width: number): string[] {
  if (raw === '') {
    return [''];
  }

  // 高亮后的行带 ANSI，缩进要从纯文本里量，正文按可见列切（保留颜色）
  const indent = /^\s*/u.exec(stripTerminalSequences(raw))?.[0] ?? '';
  const indentWidth = visibleWidth(indent);
  if (indentWidth === 0 || indentWidth >= width) {
    return wrapTextWithAnsi(raw, width);
  }

  const bodyWidth = width - indentWidth;
  const body = sliceByColumn(
    raw,
    indentWidth,
    Math.max(0, visibleWidth(raw) - indentWidth),
    true,
  );
  return wrapTextWithAnsi(body, bodyWidth).map(segment => indent + segment);
}

function topBorder(width: number, lang: string | undefined): string {
  if (lang === undefined || lang === '') {
    return '─'.repeat(width);
  }

  const label = `─── ${lang} `;
  const fill = '─'.repeat(Math.max(0, width - visibleWidth(label)));
  return `${label}${fill}`;
}
