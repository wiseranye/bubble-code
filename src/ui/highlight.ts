import type {
  HighlighterCore,
  LanguageRegistration,
  ThemedToken,
} from 'shiki/types.mjs';

// Shiki 只负责「代码 → ANSI 文本」。什么时候高亮、结果怎么塞回 markdown，
// 交给 ui 层的 Markdown 主题（见 ui/theme.ts）。

const themeName = 'github-dark';

type LanguageModule = {default: LanguageRegistration[]};

// 只登记常用语言，真正用到时才动态 import 语法文件
const languages: Record<string, () => Promise<LanguageModule>> = {
  bash: async () => import('shiki/langs/bash.mjs'),
  c: async () => import('shiki/langs/c.mjs'),
  cpp: async () => import('shiki/langs/cpp.mjs'),
  csharp: async () => import('shiki/langs/csharp.mjs'),
  css: async () => import('shiki/langs/css.mjs'),
  diff: async () => import('shiki/langs/diff.mjs'),
  dockerfile: async () => import('shiki/langs/dockerfile.mjs'),
  go: async () => import('shiki/langs/go.mjs'),
  html: async () => import('shiki/langs/html.mjs'),
  java: async () => import('shiki/langs/java.mjs'),
  javascript: async () => import('shiki/langs/javascript.mjs'),
  json: async () => import('shiki/langs/json.mjs'),
  jsx: async () => import('shiki/langs/jsx.mjs'),
  kotlin: async () => import('shiki/langs/kotlin.mjs'),
  lua: async () => import('shiki/langs/lua.mjs'),
  markdown: async () => import('shiki/langs/markdown.mjs'),
  php: async () => import('shiki/langs/php.mjs'),
  powershell: async () => import('shiki/langs/powershell.mjs'),
  python: async () => import('shiki/langs/python.mjs'),
  ruby: async () => import('shiki/langs/ruby.mjs'),
  rust: async () => import('shiki/langs/rust.mjs'),
  sql: async () => import('shiki/langs/sql.mjs'),
  swift: async () => import('shiki/langs/swift.mjs'),
  toml: async () => import('shiki/langs/toml.mjs'),
  tsx: async () => import('shiki/langs/tsx.mjs'),
  typescript: async () => import('shiki/langs/typescript.mjs'),
  xml: async () => import('shiki/langs/xml.mjs'),
  yaml: async () => import('shiki/langs/yaml.mjs'),
  zig: async () => import('shiki/langs/zig.mjs'),
};

const languageAliases: Record<string, string> = {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- 语言别名的字面量
  'c#': 'csharp',
  // eslint-disable-next-line @typescript-eslint/naming-convention -- 语言别名的字面量
  'c++': 'cpp',
  cs: 'csharp',
  docker: 'dockerfile',
  golang: 'go',
  htm: 'html',
  js: 'javascript',
  jsonc: 'json',
  kt: 'kotlin',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  ts: 'typescript',
  xhtml: 'html',
  yml: 'yaml',
  zsh: 'bash',
};

// 认不出来的语言（text/plain/自定义标记等）就当纯文本
function canonicalLang(lang: string | undefined): string | undefined {
  if (lang === undefined) {
    return undefined;
  }

  const lower = lang.toLowerCase();
  const name = languageAliases[lower] ?? lower;
  return name in languages ? name : undefined;
}

// 流式期间同一段代码会被反复渲染，按「语言 + 代码」缓存结果
const cache = new Map<string, string[]>();
const maxCacheEntries = 256;

function cacheKey(name: string, code: string): string {
  return `${name}\u0000${code}`;
}

// 同步查缓存。Markdown 组件的 highlightCode 钩子是同步接口，
// 未命中时先返回纯文本，等异步高亮算完再 invalidate 重绘。
export function peekHighlighted(
  code: string,
  lang: string | undefined,
): string[] | undefined {
  const name = canonicalLang(lang);
  if (name === undefined) {
    return plainLines(code);
  }

  return cache.get(cacheKey(name, code));
}

export async function highlightCode(
  code: string,
  lang: string | undefined,
): Promise<string[]> {
  const name = canonicalLang(lang);
  if (name === undefined) {
    return plainLines(code);
  }

  const key = cacheKey(name, code);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  let lines: string[];
  try {
    lines = await highlight(code, name);
  } catch {
    // 语法不支持、语法文件加载失败等：退化成纯文本，不再重试
    lines = plainLines(code);
  }

  remember(key, lines);
  return lines;
}

function remember(key: string, lines: string[]): void {
  if (cache.size >= maxCacheEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }

  cache.set(key, lines);
}

function plainLines(code: string): string[] {
  return code.replace(/\n+$/, '').split('\n');
}

// --------------- shiki --------------- //

let highlighterPromise: Promise<HighlighterCore> | undefined;
// 我们的键 → 语法文件里登记的名字（个别语法两者不一致）
const registeredNames = new Map<string, string>();

async function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighter();
  return highlighterPromise;
}

async function createHighlighter(): Promise<HighlighterCore> {
  // 动态 import：语法高亮按需加载，不影响启动速度。
  // 用 JS 正则引擎而不是 WASM，省掉 oniguruma 的加载开销。
  const [{createHighlighterCore}, {createJavaScriptRegexEngine}, themeModule] =
    await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/github-dark.mjs'),
    ]);

  return createHighlighterCore({
    themes: [themeModule.default],
    langs: [],
    engine: createJavaScriptRegexEngine({forgiving: true}),
  });
}

async function highlight(code: string, lang: string): Promise<string[]> {
  const highlighter = await getHighlighter();
  const registered = await ensureLanguage(highlighter, lang);
  const tokens = highlighter.codeToTokensBase(code, {
    lang: registered,
    theme: themeName,
  });

  // 行数必须和纯文本渲染时一致，否则消息高度会跟着颜色一起变
  if (tokens.length === 0) {
    return [''];
  }

  return tokens.map(line => line.map(token => tokenToAnsi(token)).join(''));
}

async function ensureLanguage(
  highlighter: HighlighterCore,
  lang: string,
): Promise<string> {
  const loaded = registeredNames.get(lang);
  if (loaded !== undefined) {
    return loaded;
  }

  const load = languages[lang];
  if (load === undefined) {
    throw new Error(`未登记的语法：${lang}`);
  }

  const module = await load();
  await highlighter.loadLanguage(module.default);

  const [registration] = module.default;
  const name = registration?.name ?? lang;
  registeredNames.set(lang, name);
  return name;
}

// --------------- ANSI --------------- //

// vscode-textmate 的 FontStyle 位标志
const italic = 1;
const bold = 2;
const underline = 4;
const strikethrough = 8;

function tokenToAnsi(token: ThemedToken): string {
  if (token.content === '') {
    return '';
  }

  const codes: string[] = [];
  const foreground = rgbCode(token.color, 38);
  if (foreground !== undefined) {
    codes.push(foreground);
  }

  const background = rgbCode(token.bgColor, 48);
  if (background !== undefined) {
    codes.push(background);
  }

  const fontStyle = token.fontStyle ?? 0;
  /* eslint-disable no-bitwise -- FontStyle 是 vscode-textmate 的位标志 */
  if ((fontStyle & bold) !== 0) {
    codes.push('1');
  }

  if ((fontStyle & italic) !== 0) {
    codes.push('3');
  }

  if ((fontStyle & underline) !== 0) {
    codes.push('4');
  }

  if ((fontStyle & strikethrough) !== 0) {
    codes.push('9');
  }

  /* eslint-enable no-bitwise */

  if (codes.length === 0) {
    return token.content;
  }

  return `\u001B[${codes.join(';')}m${token.content}\u001B[0m`;
}

// #rgb / #rrggbb / #rrggbbaa → 24 位前景色或背景色
function rgbCode(color: string | undefined, base: 38 | 48): string | undefined {
  if (color === undefined) {
    return undefined;
  }

  const match = /^#?([\da-f]{3}|[\da-f]{6})(?:[\da-f]{2})?$/i.exec(
    color.trim(),
  );
  const hex = match?.[1];
  if (hex === undefined) {
    return undefined;
  }

  const full =
    hex.length === 3
      ? [...hex].map(character => character + character).join('')
      : hex;

  const red = Number.parseInt(full.slice(0, 2), 16);
  const green = Number.parseInt(full.slice(2, 4), 16);
  const blue = Number.parseInt(full.slice(4, 6), 16);
  return `${base};2;${red};${green};${blue}`;
}
