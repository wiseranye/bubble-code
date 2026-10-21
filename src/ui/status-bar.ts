import { type Component, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type { StatusBarStyle } from '../setting-manager.ts';
import { style as themeStyle } from './theme.ts';

export type StatusBarData = {
  // undefined 表示没有配置模型
  model: { label: string; reasoning: string | undefined } | undefined;
  cwd: string;
  homeDir: string;
  // undefined 表示非 Git 仓库 / 还没读到分支
  branch: string | undefined;
  context: { used: number; window: number } | undefined;
  cache: { read: number; promptTokens: number } | undefined;
};

type BlockKey = 'model' | 'cwd' | 'branch' | 'context' | 'cache';

type Block = {
  key: BlockKey;
  prefix: string;
  value: string;
  basename: string;
  basenameTried: boolean;
};

type SegmentColor = (text: string) => string;

const pathMaxWidth = 40;

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

// Nerd Font 图标：模型、目录、分支、上下文、缓存
const icons: Record<BlockKey, string> = {
  model: '\u{F2DB}',
  cwd: '\u{F07B}',
  branch: '\u{E0A0}',
  context: '\u{F1C0}',
  cache: '\u{F0E7}',
};

// 只用前景色：终端背景色块太抢眼
const segmentColors: Record<BlockKey, SegmentColor> = {
  model: chalk.cyan,
  cwd: chalk.blue,
  branch: chalk.magenta,
  context: chalk.green,
  cache: chalk.gray,
};

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value < 1000) {
    return String(Math.round(value));
  }

  if (value < 1_000_000) {
    const rounded = Math.round(value / 100) / 10;
    return rounded >= 1000 ? '1M' : `${trimDecimal(rounded)}K`;
  }

  const rounded = Math.round(value / 100_000) / 10;
  return `${trimDecimal(rounded)}M`;
}

export function formatPercent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return '0%';
  }

  return `${Math.max(0, Math.round((part / whole) * 100))}%`;
}

// home 替换成 ~；超过上限时保留根前缀和尾部路径段，中间用 … 省略
export function formatCwd(
  cwd: string,
  homeDir: string,
  maxWidth = pathMaxWidth,
): string {
  if (maxWidth <= 0) {
    return '';
  }

  const display = abbreviateHome(cwd, homeDir);
  if (visibleWidth(display) <= maxWidth) {
    return display;
  }

  const { leading, separator, segments } = splitPath(display);
  if (segments.length === 0) {
    return fitSuffix(display, maxWidth);
  }

  for (let count = segments.length - 1; count >= 1; count--) {
    const tail = segments.slice(-count).join(separator);
    const candidate = `${leading}…${separator}${tail}`;
    if (visibleWidth(candidate) <= maxWidth) {
      return candidate;
    }
  }

  const basename = segments.at(-1) ?? display;
  const head = `${leading}…${separator}`;
  const remaining = maxWidth - visibleWidth(head);
  if (remaining > 0) {
    return `${head}${fitSuffix(basename, remaining, '')}`;
  }

  return fitSuffix(display, maxWidth);
}

export function basenameOf(pathText: string): string {
  const segments = splitSegments(pathText);
  return segments.at(-1) ?? pathText;
}

export function renderStatusLine(
  data: StatusBarData,
  barStyle: StatusBarStyle,
  width: number,
): string | undefined {
  if (width <= 0) {
    return undefined;
  }

  let blocks = buildBlocks(data, barStyle);
  let line = renderBlocks(blocks);
  while (visibleWidth(line) > width) {
    const last = blocks.at(-1);
    if (last === undefined) {
      break;
    }

    // 轮到目录块时先退化为最后一级目录，再考虑整块移除
    if (last.key === 'cwd' && !last.basenameTried) {
      last.value = last.basename;
      last.basenameTried = true;
    } else {
      blocks = blocks.slice(0, -1);
    }

    line = renderBlocks(blocks);
  }

  return blocks.length === 0 ? undefined : line;
}

export class StatusBar implements Component {
  private readonly barStyle: StatusBarStyle;

  private readonly getData: () => StatusBarData;

  constructor(options: {
    style: StatusBarStyle;
    getData: () => StatusBarData;
  }) {
    this.barStyle = options.style;
    this.getData = options.getData;
  }

  invalidate(): void {
    // 每次 render 都从 getData 取最新值，没有缓存需要清
  }

  render(width: number): string[] {
    if (width <= 0) {
      return [];
    }

    const line = renderStatusLine(this.getData(), this.barStyle, width);
    return line === undefined ? [] : [line];
  }
}

function buildBlocks(data: StatusBarData, barStyle: StatusBarStyle): Block[] {
  const decorated = barStyle !== 'default';
  const blocks: Block[] = [];

  const model =
    data.model === undefined
      ? '未配置模型'
      : `${data.model.label} (${data.model.reasoning ?? 'default'})`;
  blocks.push(makeBlock('model', model, decorated));

  const cwd = formatCwd(data.cwd, data.homeDir, pathMaxWidth);
  blocks.push(makeBlock('cwd', cwd, decorated, basenameOf(cwd)));

  if (data.branch !== undefined) {
    blocks.push(makeBlock('branch', data.branch, decorated));
  }

  if (data.context !== undefined) {
    const context = `${formatTokens(data.context.used)}/${formatTokens(
      data.context.window,
    )} (${formatPercent(data.context.used, data.context.window)})`;
    blocks.push(makeBlock('context', context, decorated));
  }

  if (data.cache !== undefined) {
    const cache = `${formatTokens(data.cache.read)} (${formatPercent(
      data.cache.read,
      data.cache.promptTokens,
    )})`;
    blocks.push(makeBlock('cache', cache, decorated));
  }

  return blocks;
}

function makeBlock(
  key: BlockKey,
  value: string,
  decorated: boolean,
  basename = value,
): Block {
  let prefix = '';
  if (decorated) {
    prefix = `${icons[key]} `;
  } else if (key === 'context') {
    prefix = '上下文 ';
  } else if (key === 'cache') {
    prefix = '缓存 ';
  }

  return {
    key,
    prefix,
    value,
    basename,
    basenameTried: false,
  };
}

function renderBlocks(blocks: Block[]): string {
  const separator = ` ${themeStyle.dim('│')} `;
  const text = blocks
    .map(block => segmentColors[block.key](`${block.prefix}${block.value}`))
    .join(separator);
  return ` ${text}`;
}

function abbreviateHome(cwd: string, homeDir: string): string {
  const home = homeDir.replace(/[\\/]+$/, '');
  if (home === '') {
    return cwd;
  }

  if (cwd === home) {
    return '~';
  }

  if (cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`)) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}

type PathParts = {
  leading: string;
  separator: string;
  segments: string[];
};

function splitPath(display: string): PathParts {
  const drive = /^([A-Za-z]:)[\\/]/.exec(display);
  if (drive !== null) {
    const separator = display[2] === '\\' ? '\\' : '/';
    return {
      leading: display.slice(0, 3),
      separator,
      segments: splitSegments(display.slice(3)),
    };
  }

  if (display.startsWith('~')) {
    const separator = display.includes('\\') ? '\\' : '/';
    return {
      leading: `~${separator}`,
      separator,
      segments: splitSegments(display.slice(1)),
    };
  }

  if (display.startsWith('/') || display.startsWith('\\')) {
    const separator = display.startsWith('/') ? '/' : '\\';
    return {
      leading: separator,
      separator,
      segments: splitSegments(display),
    };
  }

  const separator = display.includes('\\') ? '\\' : '/';
  return {
    leading: '',
    separator,
    segments: splitSegments(display),
  };
}

function splitSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter(segment => segment.length > 0);
}

// 保留字符串尾部，放不下时从头部省略
function fitSuffix(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) {
    return '';
  }

  if (visibleWidth(text) <= maxWidth) {
    return text;
  }

  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth > maxWidth) {
    return '';
  }

  const targetWidth = maxWidth - ellipsisWidth;
  const segments = [...graphemeSegmenter.segment(text)].map(
    item => item.segment,
  );
  let tail = '';
  for (let index = segments.length - 1; index >= 0; index--) {
    const candidate = `${segments[index] ?? ''}${tail}`;
    if (visibleWidth(candidate) > targetWidth) {
      break;
    }

    tail = candidate;
  }

  return `${ellipsis}${tail}`;
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
