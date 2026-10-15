import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { expect, test } from 'vitest';
import { editRenderer } from '../../src/tools/edit.render.ts';
import type { ToolRenderState } from '../../src/tools/types.ts';

// 测试环境没有 TTY，固定成 truecolor：16 色下多个色值会退化成同一个码，
// 没法断言「不同行型颜色不同」
chalk.level = 3;

function summarise(input: unknown): string | undefined {
  return editRenderer.summarise?.(input);
}

function renderBody(
  state: ToolRenderState,
  width = 80,
  expanded = true,
): string[] {
  return editRenderer.renderBody?.(state, { width, expanded }) ?? [];
}

// 底块会补空格铺满整行，行尾这些空格不算内容
function plain(lines: string[]): string[] {
  return lines.map(line => stripTerminalSequences(line).trimEnd());
}

function diffMetadata(
  oldText: string,
  newText: string,
  startLine: number,
): Record<string, unknown> {
  return { diff: { filePath: 'a.txt', oldText, newText, startLine } };
}

// 和 edit.render.ts 的亮底块同色：按当前色深取一次开/关序列，
// 断言不写死具体转义码
// 和 edit.render.ts 的配色同值：按当前色深取一次开/关序列，断言不写死转义码
function blockBackground(): [string, string] {
  const [open = '', close = ''] = chalk
    .bgHex('#12261e')('\u0000')
    .split('\u0000');

  return [open, close];
}

function colorCode(hex: string): string {
  const [open = ''] = chalk.hex(hex)('\u0000').split('\u0000');
  return open;
}

const twoHunkOld = [
  'a',
  'b',
  'B2',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'X',
  'l',
];
const twoHunkNew = [
  'a',
  'b',
  'B3',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'Y',
  'l',
];

function twoHunkState(): ToolRenderState {
  return {
    status: 'done',
    input: {
      filePath: 'a.txt',
      oldText: twoHunkOld.join('\n'),
      newText: twoHunkNew.join('\n'),
    },
    output: 'Replaced 2 occurrences in a.txt',
    success: true,
    metadata: diffMetadata(twoHunkOld.join('\n'), twoHunkNew.join('\n'), 1),
  };
}

test('edit summary is the file path without repeating the tool name', () => {
  expect(
    summarise({ filePath: 'src/app.ts', oldText: 'a', newText: 'b' }),
  ).toBe('src/app.ts');
});

test('edit summary falls back when the input does not parse', () => {
  expect(summarise({ filePath: 5, oldText: 'a' })).toBe(
    '{"filePath":5,"oldText":"a"}',
  );
});

test('renderBody is empty until the tool call is done', () => {
  expect(
    renderBody({ status: 'running', input: { filePath: 'a.txt' } }),
  ).toEqual([]);
  expect(
    renderBody({
      status: 'streaming',
      input: { filePath: 'a.txt' },
      partial: 'half',
    }),
  ).toEqual([]);
});

test('the gutter puts the sign at the left and the number right-aligned', () => {
  const state: ToolRenderState = {
    status: 'done',
    input: { filePath: 'a.txt', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' },
    output: 'Replaced 1 occurrence in a.txt',
    success: true,
    metadata: diffMetadata('a\nb\nc\n', 'a\nB\nc\n', 10),
  };

  // 空行 + 上内边距 + diff 块 + 下内边距；
  // 最大行号 12 → 列宽 3（符号 1 + 行号 2），后面 4 个空格
  expect(plain(renderBody(state))).toEqual([
    '',
    '',
    ' 10    a',
    '-11    b',
    '+11    B',
    ' 12    c',
    '',
  ]);
});

test('gutter numbers follow the side of the line, content follows the token', () => {
  // 在 a 和 b 之间插入两行：add 用新文件行号，跟在后面的 context 仍是旧文件行号
  const state: ToolRenderState = {
    status: 'done',
    input: {
      filePath: 'a.txt',
      oldText: 'a\nb\nc\n',
      newText: 'a\nx\ny\nb\nc\n',
    },
    output: 'Replaced 1 occurrence in a.txt',
    success: true,
    metadata: diffMetadata('a\nb\nc\n', 'a\nx\ny\nb\nc\n', 5),
  };

  expect(plain(renderBody(state))).toEqual([
    '',
    '',
    ' 5    a',
    '+6    x',
    '+7    y',
    ' 6    b',
    ' 7    c',
    '',
  ]);
});

test('the line number is right-aligned inside the widest column', () => {
  const state: ToolRenderState = {
    status: 'done',
    input: { filePath: 'a.txt', oldText: 'a\nb\nB2\n', newText: 'a\nb\nB3\n' },
    output: 'Replaced 1 occurrence in a.txt',
    success: true,
    metadata: diffMetadata('a\nb\nB2\nx\ny\n', 'a\nb\nB3\nx\ny\n', 98),
  };

  // 最大行号 102 → 列宽 4：两位数的行号也要右对齐到同样的宽度
  expect(plain(renderBody(state))).toEqual([
    '',
    '',
    '  98    a',
    '  99    b',
    '-100    B2',
    '+100    B3',
    ' 101    x',
    ' 102    y',
    '',
  ]);
});

test('renderBody falls back to the input without a gutter when metadata is absent', () => {
  const state: ToolRenderState = {
    status: 'done',
    input: { filePath: 'a.txt', oldText: 'a\n', newText: 'b\n' },
    output: 'Replaced 1 occurrence in a.txt',
    success: true,
  };

  // 没有行号，符号退回贴在内容上（老会话）；块前面照样留空行，内容上下有内边距
  expect(plain(renderBody(state))).toEqual(['', '', '-a', '+b', '']);
});

test('metadata written by the tool (extra fuzzy field) still renders the gutter', () => {
  const state: ToolRenderState = {
    status: 'done',
    input: { filePath: 'a.txt', oldText: 'a\n', newText: 'b\n' },
    output: 'Replaced 1 occurrence in a.txt (fuzzy match)',
    success: true,
    metadata: {
      diff: {
        filePath: 'a.txt',
        oldText: 'a\n',
        newText: 'b\n',
        startLine: 3,
        fuzzy: true,
      },
    },
  };

  // fuzzy 不再参与渲染，metadata 里多出来的字段也不该让 diff 退回无行号版本
  expect(plain(renderBody(state))).toEqual(['', '', '-3    a', '+3    b', '']);
});

test('add, del and context rows share the unified full-width block', () => {
  const [open, close] = blockBackground();
  expect(open).not.toBe('');
  const [spacer, ...lines] = renderBody(twoHunkState(), 40, true);

  expect(spacer).toBe('');
  // 15 行内容 + 上下两行内边距
  expect(lines.length).toBe(17);
  for (const line of lines) {
    expect(line.startsWith(open)).toBe(true);
    expect(line.endsWith(close)).toBe(true);
    // 底块要铺满 ctx.width：内容后面补空格
    expect(visibleWidth(line)).toBe(40);
  }
});

test('the elision row keeps the same block background', () => {
  const [open, close] = blockBackground();
  // 行序：空行、上内边距，然后 8 行块（两个 context、删、增、三个 context、省略行）
  const elision = renderBody(twoHunkState(), 40, false)[9] ?? '';

  // 行号列宽 3 + 4 个空格，后面是省略号
  expect(stripTerminalSequences(elision).trimEnd()).toBe(`${' '.repeat(7)}…`);
  expect(elision.startsWith(open)).toBe(true);
  expect(elision.endsWith(close)).toBe(true);
  expect(visibleWidth(elision)).toBe(40);
  // 省略号用行号那种暗灰，不用 context 正文色
  expect(elision).toContain(colorCode('#6e7681'));
  expect(elision).not.toContain(colorCode('#8b949e'));
});

test('the gutter follows the row type, context keeps a two-tone row', () => {
  const [open] = blockBackground();
  const state: ToolRenderState = {
    status: 'done',
    input: { filePath: 'a.txt', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' },
    output: 'Replaced 1 occurrence in a.txt',
    success: true,
    metadata: diffMetadata('a\nb\nc\n', 'a\nB\nc\n', 10),
  };
  // 前两行是空行和上内边距
  const raw = renderBody(state, 40, true).slice(2, 6);
  // 每行两个前景色：行号栏一个、内容一个（底色是 48;2;，不在这里）。
  // 正则从字符串拼出来，避免在字面量里写控制字符
  const foregroundPattern = new RegExp(`${'\u001B'}\\[38;2;[0-9;]+m`, 'g');
  const foregrounds = (line: string): string[] =>
    [...line.matchAll(foregroundPattern)].map(match => match[0]);
  const gray = colorCode('#8b949e');
  const red = colorCode('#f85149');
  const green = colorCode('#3fb950');
  const muted = colorCode('#6e7681');

  // 行型顺序：context / del / add / context，底色统一
  expect(raw.map(line => line.startsWith(open))).toEqual([
    true,
    true,
    true,
    true,
  ]);
  // 增删行的行号与正文同色，context 行的行号比正文再暗一档
  expect(foregrounds(raw[0] ?? '')).toEqual([muted, gray]);
  expect(foregrounds(raw[1] ?? '')).toEqual([red, red]);
  expect(foregrounds(raw[2] ?? '')).toEqual([green, green]);
  expect(foregrounds(raw[3] ?? '')).toEqual([muted, gray]);
});

test('the metadata-less fallback body uses the same block', () => {
  const [open, close] = blockBackground();
  const state: ToolRenderState = {
    status: 'done',
    input: { filePath: 'a.txt', oldText: 'a\n', newText: 'b\n' },
    output: 'Replaced 1 occurrence in a.txt',
    success: true,
  };

  const [spacer, ...lines] = renderBody(state, 40, true);
  expect(spacer).toBe('');
  expect(plain(lines)).toEqual(['', '-a', '+b', '']);
  expect(lines.every(line => line.startsWith(open))).toBe(true);
  expect(lines.every(line => line.endsWith(close))).toBe(true);
  expect(lines.every(line => visibleWidth(line) === 40)).toBe(true);
});

test('the cap line and failure output stay outside the block', () => {
  const [open] = blockBackground();
  const added = Array.from({ length: 10 }, (_, index) => `n${index + 1}`);
  const oldText = 'a\n';
  const newText = `${['a', ...added].join('\n')}\n`;
  const capped = renderBody(
    {
      status: 'done',
      input: { filePath: 'a.txt', oldText, newText },
      output: 'Replaced 1 occurrence in a.txt',
      success: true,
      metadata: diffMetadata(oldText, newText, 1),
    },
    40,
    false,
  );

  // 空行在块前面，提示行在块后面，两者都不属于块
  expect(capped[0]).toBe('');
  expect(capped.length).toBe(12);

  const tip = capped.at(-1) ?? '';
  expect(tip).toBe('\u001B[2m… 还有 3 行，点击展开\u001B[22m');
  expect(tip.startsWith(open)).toBe(false);

  const failed = renderBody({
    status: 'done',
    input: { filePath: 'a.txt', oldText: 'a', newText: 'b' },
    output: 'partial output',
    error: 'first error line\nsecond error line',
    success: false,
  });
  // 失败正文不是块，不加空行
  expect(failed.every(line => !line.startsWith(open))).toBe(true);
  expect(failed[0]).not.toBe('');
});

test('the block is wrapped in full-width background padding rows', () => {
  const [open, close] = blockBackground();
  const lines = renderBody(twoHunkState(), 40, true);
  const padTop = lines[1] ?? '';
  const padBottom = lines.at(-1) ?? '';

  // 第 0 行是块外的空行：没有底色
  expect(lines[0]).toBe('');
  for (const row of [padTop, padBottom]) {
    expect(row.startsWith(open)).toBe(true);
    expect(row.endsWith(close)).toBe(true);
    // 内边距行是纯空格：没有行号也没有文字
    expect(stripTerminalSequences(row)).toBe(' '.repeat(40));
    expect(visibleWidth(row)).toBe(40);
  }
  // 内容行不受影响
  expect(stripTerminalSequences(lines[2] ?? '').trimEnd()).toBe('  1    a');

  // 折叠时下内边距在提示行之前，提示行留在块外面
  const capped = renderBody(twoHunkState(), 40, false);
  const tip = capped.at(-1) ?? '';
  expect(stripTerminalSequences(tip)).toBe('… 还有 6 行，点击展开');
  expect(tip.startsWith(open)).toBe(false);
  expect(stripTerminalSequences(capped.at(-2) ?? '')).toBe(' '.repeat(40));
});

test('hasMoreBody reports content beyond the collapsed budget only', () => {
  const insertInto = (lines: string[]): ToolRenderState => {
    const oldText = `${lines.join('\n')}\n`;
    const newText = `${[...lines.slice(0, 2), 'X', ...lines.slice(2)].join('\n')}\n`;
    return {
      status: 'done',
      input: { filePath: 'a.txt', oldText, newText },
      output: 'Replaced 1 occurrence in a.txt',
      success: true,
      metadata: diffMetadata(oldText, newText, 1),
    };
  };

  // 7 行文件插入一行 → 整段 diff 8 行，预览装得下
  expect(
    editRenderer.hasMoreBody?.(insertInto(['a', 'b', 'c', 'd', 'e', 'f', 'g'])),
  ).toBe(false);
  // 8 行文件插入一行 → 整段 diff 9 行：折叠预览 8 行 + 提示行，展开还有一行
  expect(
    editRenderer.hasMoreBody?.(
      insertInto(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
    ),
  ).toBe(true);
  // 大 diff 与兜底正文
  expect(editRenderer.hasMoreBody?.(twoHunkState())).toBe(true);
  expect(
    editRenderer.hasMoreBody?.({
      status: 'done',
      input: { filePath: 'a.txt', oldText: 'a', newText: 'b' },
      output: 'partial output',
      success: false,
    }),
  ).toBe(false);
  expect(
    editRenderer.hasMoreBody?.({
      status: 'running',
      input: { filePath: 'a.txt' },
    }),
  ).toBe(false);
  // 没有 metadata 也没有可解析的输入：兜底正文是工具输出
  expect(
    editRenderer.hasMoreBody?.({
      status: 'done',
      input: null,
      output: Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join(
        '\n',
      ),
      success: true,
    }),
  ).toBe(true);
});

test('renderBody shows the whole matched span when expanded, without elision', () => {
  const lines = plain(renderBody(twoHunkState()));

  expect(lines).toEqual([
    '',
    '',
    '  1    a',
    '  2    b',
    '- 3    B2',
    '+ 3    B3',
    '  4    c',
    '  5    d',
    '  6    e',
    '  7    f',
    '  8    g',
    '  9    h',
    ' 10    i',
    ' 11    j',
    '-12    X',
    '+12    Y',
    ' 13    l',
    '',
  ]);
  expect(lines.join('\n').includes('…')).toBe(false);
});

test('a diff that fits the budget is shown in full while collapsed', () => {
  const state: ToolRenderState = {
    status: 'done',
    input: { filePath: 'a.txt', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' },
    output: 'Replaced 1 occurrence in a.txt',
    success: true,
    metadata: diffMetadata('a\nb\nc\n', 'a\nB\nc\n', 10),
  };

  const collapsed = plain(renderBody(state, 80, false));
  expect(collapsed.length).toBe(7);
  expect(collapsed.join('\n')).not.toContain('… 还有');
});

test('a long diff is context-trimmed, elided and capped while collapsed', () => {
  const collapsed = plain(renderBody(twoHunkState(), 80, false));

  // 整段 15 行装不下 8 行预算：退回裁上下文的版本（14 行，含一条省略线），再截到 8 行；
  // 块前面的空行不占预算
  expect(collapsed).toEqual([
    '',
    '',
    '  1    a',
    '  2    b',
    '- 3    B2',
    '+ 3    B3',
    '  4    c',
    '  5    d',
    '  6    e',
    '       …',
    '',
    '… 还有 6 行，点击展开',
  ]);
});

test('renderBody renders a failure as a red error above the dimmed output', () => {
  const state: ToolRenderState = {
    status: 'done',
    input: { filePath: 'a.txt', oldText: 'a', newText: 'b' },
    output: 'partial output',
    error: 'first error line\nsecond error line',
    success: false,
  };
  const raw = renderBody(state);

  expect(plain(raw)).toEqual([
    'first error line',
    'second error line',
    'partial output',
  ]);
  expect(raw[0]).toBe('\u001B[31mfirst error line\u001B[39m');
  expect(raw[2]).toBe('\u001B[2mpartial output\u001B[22m');
});

test('renderBody renders a failure without an error message', () => {
  const state: ToolRenderState = {
    status: 'done',
    input: { filePath: 'a.txt', oldText: 'a', newText: 'b' },
    output: 'nothing happened',
    success: false,
  };

  expect(plain(renderBody(state))).toEqual(['nothing happened']);
});

test('renderBody shows the raw output when no diff data is available', () => {
  const state: ToolRenderState = {
    status: 'done',
    input: null,
    output: 'Replaced 1 occurrence in a.txt',
    success: true,
  };

  // 纯输出兜底不是 diff 块，不加空行
  expect(plain(renderBody(state))).toEqual(['Replaced 1 occurrence in a.txt']);
});

test('renderBody caps the diff to 8 lines when collapsed', () => {
  const added = Array.from({ length: 10 }, (_, index) => `n${index + 1}`);
  const oldText = 'a\n';
  const newText = `${['a', ...added].join('\n')}\n`;
  const state: ToolRenderState = {
    status: 'done',
    input: { filePath: 'a.txt', oldText, newText },
    output: 'Replaced 1 occurrence in a.txt',
    success: true,
    metadata: diffMetadata(oldText, newText, 1),
  };

  // 11 行 diff：折叠时留 8 行，其余折成提示行；空行不占预算
  const collapsed = plain(renderBody(state, 80, false));
  expect(collapsed.length).toBe(12);
  expect(collapsed[0]).toBe('');
  expect(collapsed.at(-1)).toBe('… 还有 3 行，点击展开');
  expect(collapsed.slice(2, 6)).toEqual([
    '  1    a',
    '+ 2    n1',
    '+ 3    n2',
    '+ 4    n3',
  ]);

  // 展开时不截断
  const expanded = plain(renderBody(state, 80, true));
  expect(expanded.length).toBe(14);
  expect(expanded.at(-2)).toBe('+11    n10');
});

test('renderBody truncates every line to the given width', () => {
  const oldText = `${'x'.repeat(40)}\n`;
  const newText = `${'y'.repeat(40)}\n`;
  const state: ToolRenderState = {
    status: 'done',
    input: { filePath: 'a.txt', oldText, newText },
    output: 'Replaced 1 occurrence in a.txt',
    success: true,
    metadata: diffMetadata(oldText, newText, 1),
  };
  const lines = renderBody(state, 20);

  expect(lines.every(line => visibleWidth(line) <= 20)).toBe(true);
  expect(plain(lines).join('\n').includes('...')).toBe(true);
});
