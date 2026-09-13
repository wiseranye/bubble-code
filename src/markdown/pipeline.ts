import {Marked, type Token} from 'marked';
import markedShiki from 'marked-shiki';
import {highlightCode} from './highlight.js';
import {
  renderedMarker,
  renderTokens,
  sanitize,
  type MarkdownLine,
  type RenderOptions,
} from './render.js';

// marked-shiki 负责把代码块换成 shiki 渲染好的文本：它是 walkTokens 扩展，
// 会就地把 code token 改写成 html token。这里用 container 把结果包在
// renderedMarker 里，渲染时据此和模型自己写的 HTML 区分开。
const marked = new Marked(
  markedShiki({
    container: `${renderedMarker}%s`,
    async highlight(code, lang) {
      const lines = await highlightCode(code, lang);
      return lines.join('\n');
    },
  }),
);

// 词法分析 + 高亮。lexer 自己不会触发 walkTokens，按 marked 内部的做法补上这一步。
async function lexWithHighlights(content: string): Promise<Token[]> {
  const tokens = marked.lexer(sanitize(content));
  const {walkTokens} = marked.defaults;
  if (walkTokens !== null && walkTokens !== undefined) {
    await Promise.all(marked.walkTokens(tokens, walkTokens));
  }

  return tokens;
}

// 渲染结果缓存：<Static> 只写一次，定稿前必须把颜色算好，
// 所以缓存「宽度 + 内容 → 行模型」，让组件首帧就能同步读到
const rendered = new Map<string, MarkdownLine[]>();
const maxCacheEntries = 64;

function cacheKey(content: string, cols: number): string {
  return `${cols}\u0000${content}`;
}

// 同步读缓存，没有就返回 undefined（调用方先用纯文本渲染）
export function peekRendered(
  content: string,
  cols: number,
): MarkdownLine[] | undefined {
  return rendered.get(cacheKey(content, cols));
}

export async function renderHighlighted(
  content: string,
  options: RenderOptions,
): Promise<MarkdownLine[]> {
  const key = cacheKey(content, options.cols);
  const cached = rendered.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const lines = renderTokens(await lexWithHighlights(content), options);
  remember(key, lines);
  return lines;
}

// 等这些内容的高亮全部算完（成功失败都算），定稿前调用
export async function settleMarkdown(
  contents: Iterable<string>,
  cols: number,
): Promise<void> {
  await Promise.all(
    [...contents].map(content =>
      renderHighlighted(content, {cols}).catch(() => undefined),
    ),
  );
}

function remember(key: string, lines: MarkdownLine[]): void {
  if (rendered.size >= maxCacheEntries) {
    const oldest = rendered.keys().next().value;
    if (oldest !== undefined) {
      rendered.delete(oldest);
    }
  }

  rendered.set(key, lines);
}
