import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { expect, test } from 'vitest';
import type { StatusBarStyle } from '../../src/setting-manager.ts';
import {
  basenameOf,
  formatCwd,
  formatPercent,
  formatTokens,
  renderStatusLine,
  type StatusBarData,
} from '../../src/ui/status-bar.ts';

// 测试环境没有 TTY，固定成基础色，ANSI 断言才有确定结果
chalk.level = 1;

const data: StatusBarData = {
  model: { label: 'kimi-code/k3', reasoning: 'high' },
  cwd: '/Users/Random/codespace/bubble-code',
  homeDir: '/Users/Random',
  branch: 'main',
  context: { used: 128_005, window: 256_000 },
  cache: { read: 96_000, promptTokens: 128_000 },
};

function render(
  statusData: StatusBarData,
  style: StatusBarStyle,
  width: number,
): string {
  const line = renderStatusLine(statusData, style, width);
  if (line === undefined) {
    throw new Error('status line is hidden');
  }

  return line;
}

function renderPlain(
  statusData: StatusBarData,
  style: StatusBarStyle,
  width: number,
): string {
  return stripTerminalSequences(render(statusData, style, width));
}

test('formatTokens uses 1000-based units with at most one decimal', () => {
  expect(formatTokens(999)).toBe('999');
  expect(formatTokens(1234)).toBe('1.2K');
  expect(formatTokens(128_005)).toBe('128K');
  expect(formatTokens(999_950)).toBe('1M');
  expect(formatTokens(1_000_000)).toBe('1M');
  expect(formatTokens(1_024_000)).toBe('1M');
  expect(formatTokens(1_500_000)).toBe('1.5M');
});

test('formatPercent rounds and does not cap above 100%', () => {
  expect(formatPercent(128_005, 256_000)).toBe('50%');
  expect(formatPercent(96_000, 128_000)).toBe('75%');
  expect(formatPercent(300_000, 256_000)).toBe('117%');
  expect(formatPercent(1, 0)).toBe('0%');
});

test('formatCwd abbreviates home and middle-ellipsizes long paths', () => {
  expect(
    formatCwd('/Users/Random/codespace/bubble-code', '/Users/Random'),
  ).toBe('~/codespace/bubble-code');

  const long = formatCwd(
    '/Users/Random/work/company/project/src/components/button',
    '/Users/Random',
  );
  expect(visibleWidth(long)).toBeLessThanOrEqual(40);
  expect(long.startsWith('~/…/')).toBe(true);
  expect(long.endsWith('button')).toBe(true);
  expect(long).toContain('components');

  expect(formatCwd('C:\\Users\\Random\\project', 'C:\\Users\\Random')).toBe(
    '~\\project',
  );
});

test('basenameOf keeps the last path component', () => {
  expect(basenameOf('~/…/codespace/bubble-code')).toBe('bubble-code');
  expect(basenameOf('~')).toBe('~');
  expect(basenameOf('/')).toBe('/');
});

test('default style renders model first, then cwd, branch, context, cache', () => {
  expect(renderPlain(data, 'default', 200)).toBe(
    ' kimi-code/k3 (high) │ ~/codespace/bubble-code │ main │ 上下文 128K/256K (50%) │ 缓存 96K (75%)',
  );
});

test('nerdfont style replaces labels with icons', () => {
  expect(renderPlain(data, 'nerdfont', 200)).toBe(
    ' \u{F2DB} kimi-code/k3 (high) │ \u{F07B} ~/codespace/bubble-code │ \u{E0A0} main │ \u{F1C0} 128K/256K (50%) │ \u{F0E7} 96K (75%)',
  );
});

function hasBackgroundColor(value: string): boolean {
  for (const part of value.split('\x1b[')) {
    const codesText = /^([0-9;]*)m/.exec(part)?.[1];
    if (codesText === undefined) {
      continue;
    }

    const codes = codesText.split(';').map(Number);
    if (
      codes.some(
        code => (code >= 40 && code <= 47) || (code >= 100 && code <= 107),
      )
    ) {
      return true;
    }
  }

  return false;
}

test('all styles color text without background colors', () => {
  for (const style of ['default', 'nerdfont', 'powerline'] as const) {
    const line = render(data, style, 200);
    expect(line).toContain('\x1b[');
    expect(hasBackgroundColor(line)).toBe(false);
    expect(stripTerminalSequences(line)).toContain('kimi-code/k3');
  }
});

test('all styles use vertical bar separators', () => {
  for (const style of ['default', 'nerdfont', 'powerline'] as const) {
    const plain = stripTerminalSequences(render(data, style, 200));
    expect(plain).toContain(' │ ');
    expect(plain).not.toContain('\u{E0B0}');
  }
});

test('powerline style uses separators without background colors', () => {
  const line = render(data, 'powerline', 200);
  const plain = stripTerminalSequences(line);

  expect(hasBackgroundColor(line)).toBe(false);
  expect(visibleWidth(line)).toBeLessThanOrEqual(200);
  expect(plain).toContain('kimi-code/k3 (high)');
  expect(plain).toContain('~/codespace/bubble-code');
  expect(plain).toContain('main');
  expect(plain).toContain('128K/256K (50%)');
  expect(plain).toContain('96K (75%)');
  expect(plain).not.toContain('上下文');
  expect(plain).not.toContain('缓存');
});

test('blocks disappear from right to left', () => {
  const wide = renderPlain(data, 'default', 90);
  expect(wide).not.toContain('缓存');
  expect(wide).toContain('上下文');

  const medium = renderPlain(data, 'default', 75);
  expect(medium).not.toContain('上下文');
  expect(medium).toContain('main');

  const narrow = renderPlain(data, 'default', 50);
  expect(narrow).not.toContain('main');
  expect(narrow).toContain('bubble-code');
});

test('cwd degrades to the last component before being removed', () => {
  const line = renderPlain(data, 'default', 40);
  expect(line).toContain('bubble-code');
  expect(line).not.toContain('~/codespace');
  expect(line).toContain('kimi-code/k3');
});

test('the line is hidden when no block fits', () => {
  expect(renderStatusLine(data, 'default', 10)).toBeUndefined();
  expect(renderStatusLine(data, 'nerdfont', 5)).toBeUndefined();
  expect(renderStatusLine(data, 'powerline', 1)).toBeUndefined();
});

test('omits model-dependent segments when no model is configured', () => {
  const line = renderPlain(
    {
      ...data,
      model: undefined,
      branch: undefined,
      context: undefined,
      cache: undefined,
    },
    'default',
    200,
  );

  expect(line).toBe(' 未配置模型 │ ~/codespace/bubble-code');
});

test('omits the branch outside a git repository', () => {
  const line = renderPlain({ ...data, branch: undefined }, 'default', 200);
  expect(line).not.toContain('main');
  expect(line).toContain('bubble-code');
});

test('omits the cache segment when there is no cache data', () => {
  const line = renderPlain({ ...data, cache: undefined }, 'default', 200);
  expect(line).not.toContain('缓存');
  expect(line).toContain('上下文');
});
