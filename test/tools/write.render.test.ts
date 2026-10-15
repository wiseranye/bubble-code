import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { expect, test } from 'vitest';
import type { ToolRenderState } from '../../src/tools/types.ts';
import { writeRenderer } from '../../src/tools/write.render.ts';

// 测试环境没有 TTY，固定成 truecolor：16 色下多个色值会退化成同一个码
chalk.level = 3;

function summarise(input: unknown): string | undefined {
  return writeRenderer.summarise?.(input);
}

function renderBody(
  state: ToolRenderState,
  width = 60,
  expanded = true,
): string[] {
  return writeRenderer.renderBody?.(state, { width, expanded }) ?? [];
}

// 底块会补空格铺满整行，行尾这些空格不算内容
function plain(lines: string[]): string[] {
  return lines.map(line => stripTerminalSequences(line).trimEnd());
}

// 和 block.render.ts 的配色同值：按当前色深取开/关序列，断言不写死转义码
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

type DoneState = Extract<ToolRenderState, { status: 'done' }>;

function writeState(
  content: string,
  extra: Partial<DoneState> = {},
): DoneState {
  return {
    status: 'done',
    input: { filePath: 'a.txt', content },
    output: 'Successfully wrote to a.txt',
    success: true,
    ...extra,
  };
}

const fifteenLines = Array.from(
  { length: 15 },
  (_, index) => `line ${index + 1}`,
);

test('write summary shows the path and the number of lines written', () => {
  expect(summarise({ filePath: 'a.txt', content: 'x\ny\n' })).toBe(
    'a.txt (2 行)',
  );
  expect(summarise({ filePath: 'a.txt', content: 'x' })).toBe('a.txt (1 行)');
  expect(summarise({ filePath: 'a.txt', content: '' })).toBe('a.txt (0 行)');
});

test('write summary counts a blank line at the end of the content', () => {
  expect(summarise({ filePath: 'a.txt', content: 'a\nb\n\n' })).toBe(
    'a.txt (3 行)',
  );
});

test('write summary falls back when the input does not parse', () => {
  expect(summarise({ filePath: 'a.txt' })).toBe('a.txt');
  expect(summarise({ filePath: 5, content: 'x' })).toBe(
    '{"filePath":5,"content":"x"}',
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

test('the written content renders as a numbered block after a blank line', () => {
  const lines = renderBody(writeState('x\ny\n'));

  // 空行 + 上内边距 + 块 + 下内边距；
  // 行号是空格符号 + 右对齐的行号，后面 4 个空格
  expect(plain(lines)).toEqual(['', '', ' 1    x', ' 2    y', '']);
});

test('content line numbers are right-aligned inside the widest column', () => {
  const lines = renderBody(
    writeState(`${fifteenLines.join('\n')}\n`),
    60,
    true,
  );

  expect(plain(lines).slice(0, 4)).toEqual([
    '',
    '',
    '  1    line 1',
    '  2    line 2',
  ]);
  // 倒数第二行是 15 行内容，最后一行是下内边距
  expect(plain(lines).at(-2)).toBe(' 15    line 15');
});

test('every content row paints the unified full-width block', () => {
  const [open, close] = blockBackground();
  expect(open).not.toBe('');
  const lines = renderBody(writeState(`${fifteenLines.join('\n')}\n`));
  // 行序：空行 + 上内边距 + 15 行内容 + 下内边距
  const rows = lines.slice(2, -1);

  expect(lines[0]).toBe('');
  expect(rows.length).toBe(15);
  for (const row of rows) {
    expect(row.startsWith(open)).toBe(true);
    expect(row.endsWith(close)).toBe(true);
    // 底块要铺满 ctx.width：内容后面补空格
    expect(visibleWidth(row)).toBe(60);
  }
});

test('the block is wrapped in full-width background padding rows', () => {
  const [open, close] = blockBackground();
  const lines = renderBody(writeState('x\ny\n'), 60, false);
  const padTop = lines[1] ?? '';
  const padBottom = lines.at(-1) ?? '';

  expect(lines[0]).toBe('');
  for (const row of [padTop, padBottom]) {
    expect(row.startsWith(open)).toBe(true);
    expect(row.endsWith(close)).toBe(true);
    // 内边距行是纯空格：没有行号也没有文字
    expect(stripTerminalSequences(row)).toBe(' '.repeat(60));
    expect(visibleWidth(row)).toBe(60);
  }
});

test('the block colors the gutter dim gray and the content gray', () => {
  const [open] = blockBackground();
  const rows = renderBody(writeState('x\ny\n')).slice(2, -1);
  // 每行两个前景色：行号栏一个、内容一个（底色是 48;2;，不在这里）。
  // 正则从字符串拼出来，避免在字面量里写控制字符
  const foregroundPattern = new RegExp(`${'\u001B'}\\[38;2;[0-9;]+m`, 'g');
  const foregrounds = (line: string): string[] =>
    [...line.matchAll(foregroundPattern)].map(match => match[0]);

  for (const row of rows) {
    expect(row.startsWith(open)).toBe(true);
    expect(foregrounds(row)).toEqual([
      colorCode('#6e7681'),
      colorCode('#8b949e'),
    ]);
  }
});

test('a long file is capped to 8 rows with an expand hint while collapsed', () => {
  const collapsed = plain(
    renderBody(writeState(`${fifteenLines.join('\n')}\n`), 60, false),
  );

  // 空行和内边距都不占预算：上内边距 + 8 行预览 + 下内边距 + 提示行
  expect(collapsed.length).toBe(12);
  expect(collapsed[0]).toBe('');
  expect(collapsed.slice(2, 4)).toEqual(['  1    line 1', '  2    line 2']);
  expect(collapsed.at(-2)).toBe('');
  expect(collapsed.at(-1)).toBe('… 还有 7 行，点击展开');
});

test('a short file fits the budget and gets no cap hint', () => {
  const collapsed = plain(renderBody(writeState('x\ny\n'), 60, false));

  expect(collapsed).toEqual(['', '', ' 1    x', ' 2    y', '']);
  expect(collapsed.join('\n')).not.toContain('… 还有');
});

test('an empty file renders a dim placeholder without a block', () => {
  const [open] = blockBackground();
  const lines = renderBody(writeState(''));

  expect(lines).toEqual(['\u001B[2m（空文件）\u001B[22m']);
  expect(lines[0]?.startsWith(open)).toBe(false);
});

test('a trailing newline does not add a phantom row', () => {
  expect(plain(renderBody(writeState('a\nb\n')))).toEqual([
    '',
    '',
    ' 1    a',
    ' 2    b',
    '',
  ]);
  // 末尾的空白行仍然算一行，和 summarise 的行数一致
  expect(plain(renderBody(writeState('a\nb\n\n')))).toEqual([
    '',
    '',
    ' 1    a',
    ' 2    b',
    ' 3',
    '',
  ]);
});

test('hasMoreBody reports content beyond the collapsed budget only', () => {
  const rows = (count: number): string =>
    `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')}\n`;

  expect(writeRenderer.hasMoreBody?.(writeState(rows(8)))).toBe(false);
  expect(writeRenderer.hasMoreBody?.(writeState(rows(9)))).toBe(true);
  expect(writeRenderer.hasMoreBody?.(writeState(''))).toBe(false);
  expect(
    writeRenderer.hasMoreBody?.(
      writeState('x\n', { success: false, output: '', error: 'boom' }),
    ),
  ).toBe(false);
  expect(
    writeRenderer.hasMoreBody?.({
      status: 'running',
      input: { filePath: 'a.txt', content: rows(9) },
    }),
  ).toBe(false);
  // 输入解析不出来：兜底正文是工具输出，同样按预算折叠
  expect(
    writeRenderer.hasMoreBody?.({
      status: 'done',
      input: { filePath: 'a.txt' },
      output: rows(9).trimEnd(),
      success: true,
    }),
  ).toBe(true);
});

test('a failure renders the error above the output without a block', () => {
  const [open] = blockBackground();
  const raw = renderBody(
    writeState('x\n', {
      success: false,
      output: 'partial output',
      error: 'EACCES: permission denied',
    }),
  );

  expect(plain(raw)).toEqual(['EACCES: permission denied', 'partial output']);
  expect(raw[0]).toBe('\u001B[31mEACCES: permission denied\u001B[39m');
  expect(raw[1]).toBe('\u001B[2mpartial output\u001B[22m');
  expect(raw.every(line => !line.startsWith(open))).toBe(true);
});

test('an unparsable input falls back to the dimmed tool output', () => {
  const [open] = blockBackground();
  const raw = renderBody({
    status: 'done',
    input: { filePath: 'a.txt' },
    output: 'Successfully wrote to a.txt',
    success: true,
  });

  expect(raw).toEqual(['\u001B[2mSuccessfully wrote to a.txt\u001B[22m']);
  expect(raw[0]?.startsWith(open)).toBe(false);
});
