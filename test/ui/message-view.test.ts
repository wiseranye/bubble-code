import {
  stripTerminalSequences,
  type TuiMouseEvent,
  visibleWidth,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { expect, test } from 'vitest';
import type { ToolChatMessage } from '../../src/agent/agent-session.ts';
import {
  createSkillActivation,
  formatSkillActivation,
  type Skill,
} from '../../src/agent/skills.ts';
import { newToolRegistry } from '../../src/tools/index.ts';
import { peekHighlighted } from '../../src/ui/highlight.ts';
import {
  AssistantMessageView,
  createMessageView,
  SkillActivationMessageView,
  ToolMessageView,
} from '../../src/ui/message-view.ts';
import { defaultToolRenderer } from '../../src/ui/tool-render-default.ts';

// 测试环境没有 TTY，固定成基础色，颜色断言才有确定结果
chalk.level = 1;

// 工具渲染走真实注册中心：没有 render 的 bash 覆盖兜底渲染器，
// read / edit 覆盖自带的 render
const tools = newToolRegistry();

function plain(lines: string[]): string[] {
  return lines.map(line => stripTerminalSequences(line));
}

function toolView(message: ToolChatMessage): ToolMessageView {
  const view = createMessageView(message, tools, () => undefined);
  if (!(view instanceof ToolMessageView)) {
    throw new TypeError('expected a tool message view');
  }

  return view;
}

function clickAt(y: number): TuiMouseEvent {
  return {
    type: 'click',
    button: 'left',
    x: 0,
    y,
    screenX: 0,
    screenY: y,
    width: 40,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

test('user message keeps the marker column and wraps continuations', () => {
  const view = createMessageView(
    { id: 1, role: 'user', content: '第一行\n第二行' },
    tools,
    () => undefined,
  );
  const lines = plain(view.render(20));

  expect(lines[0]?.startsWith('● 第一行')).toBe(true);
  expect(lines[1]).toBe('  第二行');
});

test('assistant message renders markdown behind the marker', () => {
  const view = new AssistantMessageView('**你好**，世界', () => undefined);
  const lines = plain(view.render(30));

  expect(lines[0]?.startsWith('◎ ')).toBe(true);
  expect(lines.join('\n').includes('你好，世界')).toBe(true);
});

test('sealing pre-computes syntax highlighting for code blocks', async () => {
  const code = 'const answer: number = 42;';
  const view = new AssistantMessageView(
    `示例：\n\n\`\`\`ts\n${code}\n\`\`\`\n`,
    () => undefined,
  );

  await view.seal();

  // 高亮已经进缓存，下次渲染就是带颜色的版本
  expect(peekHighlighted(code, 'ts')).toBeTruthy();
  expect(plain(view.render(60)).join('\n').includes(code)).toBe(true);
});

test('code blocks render between horizontal rules without fences', () => {
  const view = new AssistantMessageView(
    '说明：\n\n```ts\nconst answer = 42;\n```\n',
    () => undefined,
  );
  const lines = plain(view.render(40));
  const text = lines.join('\n');

  expect(text.includes('```')).toBe(false);
  expect(text.includes('─── ts')).toBe(true);
  expect(lines.some(line => /^ {2}─+$/u.test(line))).toBe(true);
  expect(
    lines.some(line => line.trimEnd().endsWith('const answer = 42;')),
  ).toBe(true);
  // 代码行不带竖线/拐角，复制时不会被选进去
  expect(lines.some(line => line.includes('│'))).toBe(false);
  expect(text.includes('┌')).toBe(false);
  // 行尾没有补齐到整宽的空格
  const codeLine = lines.find(line => line.includes('const answer = 42;'));
  expect(codeLine !== undefined).toBe(true);
  expect(codeLine?.endsWith(' ')).toBe(false);
  expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true);
});

test('long code lines wrap between the rules', () => {
  const long = 'x'.repeat(80);
  const view = new AssistantMessageView(
    `\`\`\`\n${long}\n\`\`\``,
    () => undefined,
  );
  const lines = plain(view.render(30));
  const rules = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^(?:◎ | {2})─+$/u.test(line))
    .map(({ index }) => index);
  const top = rules[0] ?? -1;
  const bottom = rules[1] ?? -1;

  expect(top >= 0).toBe(true);
  expect(bottom > top).toBe(true);
  const content = lines.slice(top + 1, bottom);
  expect(content.length > 1).toBe(true);
  expect(content.every(line => /^ {2}x+$/u.test(line))).toBe(true);
  expect(lines.every(line => visibleWidth(line) <= 30)).toBe(true);
});

test('wrapped code lines keep their indentation', async () => {
  const long = 'a'.repeat(60);
  const view = new AssistantMessageView(
    `\`\`\`python\ndef f():\n    total = ${long}\n\`\`\``,
    () => undefined,
  );
  await view.seal();

  const lines = plain(view.render(30));
  const top = lines.findIndex(line => line.includes('─── python'));
  const bottom = lines.findIndex(
    (line, index) => index > top && /^ {2}─+$/u.test(line),
  );
  const content = lines.slice(top + 1, bottom);
  const wrapped = content.filter(line =>
    /^(?:total|a+)/u.test(line.trimStart()),
  );

  expect(wrapped.length > 1).toBe(true);
  // 标记缩进 2 + 代码缩进 4：折出来的每一行都要保留
  expect(wrapped.every(line => line.startsWith('      '))).toBe(true);
  // 切正文不能把语法高亮的颜色弄丢
  expect(view.render(30).some(line => line.includes('\u001B['))).toBe(true);
});

test('async highlighting notifies the view to repaint', async () => {
  const code = 'const flag: boolean = true;';
  let ready = 0;
  const view = new AssistantMessageView(`\`\`\`ts\n${code}\n\`\`\``, () => {
    ready++;
  });

  // 首帧未命中缓存，同步返回纯文本并调度异步高亮
  view.render(60);
  await until(() => ready > 0);

  expect(ready > 0).toBe(true);
});

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) {
      return;
    }

    await new Promise<void>(resolve => {
      setImmediate(resolve);
    });
  }

  throw new Error('condition not met');
}

test('tool message puts the summary on the header and caps the body at 8 lines', () => {
  const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  const view = toolView({
    id: 2,
    role: 'tool',
    toolCallId: 'call-1',
    name: 'bash',
    input: '{"command":"ls"}',
    output: output.join('\n'),
    status: 'done',
    success: true,
  });
  const lines = plain(view.render(40));
  const text = lines.join('\n');

  expect(lines[0]).toBe('⚙ bash → ls ▸');
  expect(lines[1]).toBe('  line 1');
  expect(text.includes('line 8')).toBe(true);
  expect(text.includes('line 9')).toBe(false);
  expect(lines.at(-1)).toBe('  … 还有 2 行，点击展开');
});

test('expanding reveals every line and requests a repaint', () => {
  const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  const message: ToolChatMessage = {
    id: 3,
    role: 'tool',
    toolCallId: 'call-2',
    name: 'bash',
    input: '{"command":"ls"}',
    output: output.join('\n'),
    status: 'done',
    success: true,
  };
  let repaints = 0;
  const view = new ToolMessageView(message, defaultToolRenderer, () => {
    repaints++;
  });

  const collapsed = plain(view.render(40));
  expect(collapsed.length).toBe(10);
  expect(collapsed.at(-1)).toBe('  … 还有 2 行，点击展开');

  view.toggleExpanded();

  const expanded = plain(view.render(40));
  expect(expanded[0]).toBe('⚙ bash → ls ▾');
  expect(expanded.length).toBe(12);
  expect(expanded.at(-2)).toBe('  line 10');
  expect(expanded.at(-1)).toBe('  … 点击收起');
  expect(expanded.join('\n').includes('… 还有')).toBe(false);
  expect(repaints).toBe(1);

  // 展开后点头部行收回
  expect(view.handleMouse(clickAt(0))).toEqual({
    handled: true,
    render: true,
  });
  expect(plain(view.render(40)).length).toBe(10);
  expect(repaints).toBe(2);
});

test('clicking the collapsed body tip expands, other rows do not', () => {
  const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  const view = toolView({
    id: 4,
    role: 'tool',
    toolCallId: 'call-3',
    name: 'bash',
    input: '{"command":"ls"}',
    output: output.join('\n'),
    status: 'done',
    success: true,
  });

  view.render(40);
  // 正文中间的行不是点击目标
  expect(view.handleMouse(clickAt(3))).toBeUndefined();
  expect(plain(view.render(40)).length).toBe(10);

  // 最后一行是「… 还有 N 行，点击展开」提示
  expect(view.handleMouse(clickAt(9))).toEqual({ handled: true, render: true });
  expect(plain(view.render(40)).length).toBe(12);
});

test('the fold indicator flips and the collapse row folds the message back', () => {
  const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  const view = toolView({
    id: 13,
    role: 'tool',
    toolCallId: 'call-12',
    name: 'bash',
    input: '{"command":"ls"}',
    output: output.join('\n'),
    status: 'done',
    success: true,
  });

  const collapsed = plain(view.render(40));
  expect(collapsed[0]).toBe('⚙ bash → ls ▸');
  expect(collapsed.at(-1)).toBe('  … 还有 2 行，点击展开');

  view.toggleExpanded();

  const expanded = plain(view.render(40));
  expect(expanded[0]).toBe('⚙ bash → ls ▾');
  const collapseRow = expanded.length - 1;
  expect(expanded.at(-1)).toBe('  … 点击收起');

  // 收起行是点击目标，中间的行不是
  expect(view.handleMouse({ ...clickAt(5), type: 'press' })).toBeUndefined();
  expect(view.handleMouse({ ...clickAt(collapseRow), type: 'press' })).toEqual({
    handled: true,
  });
  expect(plain(view.render(40))[0]).toBe('⚙ bash → ls ▾');

  expect(view.handleMouse(clickAt(collapseRow))).toEqual({
    handled: true,
    render: true,
  });
  const back = plain(view.render(40));
  expect(back[0]).toBe('⚙ bash → ls ▸');
  expect(back).toEqual(collapsed);
});

test('a short output has no fold indicator and no collapse row', () => {
  const view = toolView({
    id: 14,
    role: 'tool',
    toolCallId: 'call-13',
    name: 'bash',
    input: '{"command":"ls"}',
    output: 'one\ntwo',
    status: 'done',
    success: true,
  });

  expect(plain(view.render(40))).toEqual(['⚙ bash → ls', '  one', '  two']);

  view.toggleExpanded();

  const expanded = plain(view.render(40));
  expect(expanded).toEqual(['⚙ bash → ls', '  one', '  two']);
  expect(expanded.join('\n').includes('点击收起')).toBe(false);
});

test('a nine-row body expands even though preview plus tip is as long', () => {
  // 折叠预览 8 行 + 提示行，和展开后的 9 行一样长：
  // 展开性由渲染器判断，不能数正文行数
  const view = toolView({
    id: 15,
    role: 'tool',
    toolCallId: 'call-14',
    name: 'bash',
    input: '{"command":"ls"}',
    output: Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join(
      '\n',
    ),
    status: 'done',
    success: true,
  });

  const collapsed = plain(view.render(40));
  expect(collapsed[0]).toBe('⚙ bash → ls ▸');
  expect(collapsed.length).toBe(10);
  expect(collapsed.at(-1)).toBe('  … 还有 1 行，点击展开');

  // 提示行确实能点开
  expect(view.handleMouse({ ...clickAt(9), type: 'press' })).toEqual({
    handled: true,
  });
  expect(view.handleMouse(clickAt(9))).toEqual({ handled: true, render: true });

  const expanded = plain(view.render(40));
  expect(expanded[0]).toBe('⚙ bash → ls ▾');
  expect(expanded.length).toBe(11);
  expect(expanded[9]).toBe('  line 9');
  expect(expanded.at(-1)).toBe('  … 点击收起');
});

test('a nine-row edit body is expandable too', () => {
  // 8 行文件里插入一行：整段 diff 9 行，折叠预览裁到 7 行（没有提示行）
  const fileLines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const inserted = ['a', 'b', 'X', 'c', 'd', 'e', 'f', 'g', 'h'];
  const oldText = `${fileLines.join('\n')}\n`;
  const newText = `${inserted.join('\n')}\n`;
  const view = toolView({
    id: 16,
    role: 'tool',
    toolCallId: 'call-15',
    name: 'edit',
    input: JSON.stringify({ filePath: 'a.txt', oldText, newText }),
    output: 'Replaced 1 occurrence in a.txt',
    status: 'done',
    success: true,
    metadata: { diff: { filePath: 'a.txt', oldText, newText, startLine: 1 } },
  });
  const rows = (): string[] =>
    plain(view.render(40)).map(line => line.trimEnd());

  const collapsed = rows();
  expect(collapsed[0]).toBe('⚙ edit → a.txt ▸');
  expect(collapsed.length).toBe(11);

  view.handleMouse(clickAt(0));

  const expanded = rows();
  expect(expanded[0]).toBe('⚙ edit → a.txt ▾');
  expect(expanded.length).toBe(14);
  expect(expanded.at(-1)).toBe('  … 点击收起');
});

test('a body that exactly fits the collapsed budget gets no affordance', () => {
  const view = toolView({
    id: 17,
    role: 'tool',
    toolCallId: 'call-16',
    name: 'bash',
    input: '{"command":"ls"}',
    output: Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join(
      '\n',
    ),
    status: 'done',
    success: true,
  });

  const collapsed = plain(view.render(40));
  expect(collapsed[0]).toBe('⚙ bash → ls');
  expect(collapsed.length).toBe(9);

  view.toggleExpanded();

  const expanded = plain(view.render(40));
  expect(expanded[0]).toBe('⚙ bash → ls');
  expect(expanded.join('\n')).not.toContain('点击收起');
});

test('a tool without its own body renderer uses the generic budget', () => {
  // read 只有 summarise：正文走通用渲染器，展开性也跟随它
  const view = toolView({
    id: 18,
    role: 'tool',
    toolCallId: 'call-17',
    name: 'read',
    input: '{"filePath":"src/app.ts"}',
    output: Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join(
      '\n',
    ),
    status: 'done',
    success: true,
  });

  const collapsed = plain(view.render(80));
  expect(collapsed[0]).toBe('⚙ read → src/app.ts ▸');
  expect(collapsed.at(-1)).toBe('  … 还有 1 行，点击展开');
});

test('the header press is handled without toggling', () => {
  const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  const view = toolView({
    id: 12,
    role: 'tool',
    toolCallId: 'call-11',
    name: 'bash',
    input: '{"command":"ls"}',
    output: output.join('\n'),
    status: 'done',
    success: true,
  });

  view.render(40);
  // 全屏 TUI 先发 press，再在 release 时补发 click：press 不接就没有 click。
  // 这里只记目标、不切换，按住后拖到别处松开不会误触
  expect(view.handleMouse({ ...clickAt(0), type: 'press' })).toEqual({
    handled: true,
  });
  expect(plain(view.render(40)).length).toBe(10);
  expect(view.handleMouse({ ...clickAt(3), type: 'press' })).toBeUndefined();
});

test('a failure update renders the error in red above the dimmed output', () => {
  const running: ToolChatMessage = {
    id: 5,
    role: 'tool',
    toolCallId: 'call-4',
    name: 'bash',
    input: '{"command":"false"}',
    output: '',
    status: 'running',
    success: true,
  };
  const view = toolView(running);
  expect(plain(view.render(40))).toEqual(['⚙ bash（执行中…） → false']);

  view.update({
    ...running,
    status: 'done',
    success: false,
    output: 'partial output',
    error: 'boom',
  });

  const raw = view.render(40);
  expect(plain(raw)).toEqual(['✗ bash → false', '  boom', '  partial output']);
  expect(raw[1]).toBe('  \u001B[31mboom\u001B[39m');
  expect(raw[2]).toBe('  \u001B[2mpartial output\u001B[22m');
});

test('an edit message previews the diff and expands on click', () => {
  const oldLines = [
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
  const newLines = [...oldLines];
  newLines[2] = 'B3';
  newLines[11] = 'Y';
  const oldText = `${oldLines.join('\n')}\n`;
  const newText = `${newLines.join('\n')}\n`;
  const message: ToolChatMessage = {
    id: 6,
    role: 'tool',
    toolCallId: 'call-5',
    name: 'edit',
    input: JSON.stringify({ filePath: 'a.txt', oldText, newText }),
    output: 'Replaced 2 occurrences in a.txt',
    status: 'done',
    success: true,
    metadata: {
      diff: { filePath: 'a.txt', oldText, newText, startLine: 1 },
    },
  };
  const view = toolView(message);
  // 底块会把行补满宽度，行尾空格不算内容
  const rows = (): string[] =>
    plain(view.render(40)).map(line => line.trimEnd());

  // 折叠时：空行 + 上内边距 + 8 行预览 + 下内边距 + 提示行（整段 15 行装不下预算）
  const collapsed = rows();
  expect(collapsed.length).toBe(13);
  expect(collapsed[0]).toBe('⚙ edit → a.txt ▸');
  expect(collapsed[1]).toBe('');
  expect(collapsed[2]).toBe('');
  expect(collapsed.slice(3, 7)).toEqual([
    '    1    a',
    '    2    b',
    '  - 3    B2',
    '  + 3    B3',
  ]);
  expect(collapsed.at(-2)).toBe('');
  expect(collapsed.at(-1)).toBe('  … 还有 6 行，点击展开');

  view.handleMouse(clickAt(0));

  const expanded = rows();
  expect(expanded[0]).toBe('⚙ edit → a.txt ▾');
  expect(expanded.length).toBe(20);
  expect(expanded.at(-3)).toBe('   13    l');
  expect(expanded.at(-2)).toBe('');
  expect(expanded.at(-1)).toBe('  … 点击收起');
  expect(expanded.includes('  -12    X')).toBe(true);
  expect(expanded.join('\n').includes('… 还有')).toBe(false);

  // 收起行的行号把空行也算进去：点它收回折叠态
  view.handleMouse(clickAt(expanded.length - 1));
  expect(rows()).toEqual(collapsed);
});

test('a failed edit shows its error in the preview', () => {
  const view = toolView({
    id: 10,
    role: 'tool',
    toolCallId: 'call-9',
    name: 'edit',
    input: JSON.stringify({
      filePath: 'a.txt',
      oldText: 'a\n',
      newText: 'b\n',
    }),
    output: '',
    error: 'old text not found in a.txt',
    status: 'done',
    success: false,
  });

  expect(plain(view.render(40))).toEqual([
    '✗ edit → a.txt',
    '  old text not found in a.txt',
  ]);
});

test('an edit with nothing to show renders the header only', () => {
  const view = toolView({
    id: 11,
    role: 'tool',
    toolCallId: 'call-10',
    name: 'edit',
    input: JSON.stringify({
      filePath: 'a.txt',
      oldText: 'a\n',
      newText: 'b\n',
    }),
    output: '',
    status: 'done',
    success: false,
  });

  expect(plain(view.render(40))).toEqual(['✗ edit → a.txt']);
});

test('read messages use the summariser from their tool renderer', () => {
  const view = toolView({
    id: 7,
    role: 'tool',
    toolCallId: 'call-6',
    name: 'read',
    input: '{"filePath":"src/app.ts","offset":10,"limit":20}',
    output: 'src/app.ts',
    status: 'done',
    success: true,
  });

  expect(plain(view.render(80))[0]).toBe(
    '⚙ read → src/app.ts（第 10 行起，共 20 行）',
  );
});

test('expanded survives an update of the same message', () => {
  const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  const running: ToolChatMessage = {
    id: 8,
    role: 'tool',
    toolCallId: 'call-7',
    name: 'bash',
    input: '{"command":"ls"}',
    output: '',
    status: 'running',
    success: true,
  };
  const view = toolView(running);

  view.render(40);
  view.toggleExpanded();
  view.update({ ...running, status: 'done', output: output.join('\n') });

  const lines = plain(view.render(40));
  expect(lines.length).toBe(12);
  expect(lines.at(-2)).toBe('  line 10');
  expect(lines.at(-1)).toBe('  … 点击收起');
});

test('an unknown tool name falls back to the generic renderer', () => {
  const view = toolView({
    id: 9,
    role: 'tool',
    toolCallId: 'call-8',
    name: 'gone-tool',
    input: 'not json',
    output: 'output',
    status: 'done',
    success: true,
  });

  expect(plain(view.render(40))).toEqual([
    '⚙ gone-tool → not json',
    '  output',
  ]);
});

test('SKILL.md reads collapse to one skill header and expand captured output', () => {
  const output =
    '---\nname: demo\ndescription: Demo\n---\n# Body\n\n[Showing lines 1-5 of 20. Use offset=6 to continue.]';
  const view = toolView({
    id: 19,
    role: 'tool',
    toolCallId: 'call-skill',
    name: 'read',
    input: '{"filePath":"/tmp/demo/SKILL.md"}',
    output,
    status: 'done',
    success: true,
  });

  expect(plain(view.render(100))).toEqual(['⚙ skill → /tmp/demo/SKILL.md ▸']);

  view.toggleExpanded();
  const expanded = plain(view.render(100));
  expect(expanded[0]).toBe('⚙ skill → /tmp/demo/SKILL.md ▾');
  expect(expanded).toContain('  ---');
  expect(expanded).toContain('  # Body');
  expect(expanded.some(line => line.includes('Use offset=6'))).toBe(true);
  expect(expanded.at(-1)).toBe('  … 点击收起');
});

test('failed SKILL.md reads keep the error visible under a red skill header', () => {
  const view = toolView({
    id: 20,
    role: 'tool',
    toolCallId: 'call-skill-error',
    name: 'read',
    input: '{"filePath":"/tmp/missing/SKILL.md"}',
    output: '',
    error: 'File not found',
    status: 'done',
    success: false,
  });

  expect(plain(view.render(80))).toEqual([
    '✗ skill → /tmp/missing/SKILL.md',
    '  File not found',
  ]);
});

test('manual activation renders a skill record instead of XML and keeps extra text', () => {
  const skill: Skill = {
    name: 'markitdown',
    description: 'Convert documents',
    location: '/tmp/markitdown/SKILL.md',
    body: '# Body\n\nInstructions',
  };
  const activation = createSkillActivation(skill, '检查文档');
  const content = formatSkillActivation(activation);
  const view = createMessageView(
    { id: 21, role: 'user', content, skillActivation: activation },
    tools,
    () => undefined,
  );
  if (!(view instanceof SkillActivationMessageView)) {
    throw new TypeError('expected a skill activation view');
  }

  const collapsed = plain(view.render(100));
  expect(collapsed).toEqual([
    '⚙ skill → markitdown — /tmp/markitdown/SKILL.md ▸',
    '● 检查文档',
  ]);
  expect(collapsed.join('\n')).not.toContain('<skill');

  expect(view.handleMouse({ ...clickAt(0), type: 'press' })).toEqual({
    handled: true,
  });
  expect(view.handleMouse(clickAt(0))).toEqual({ handled: true, render: true });
  const expanded = plain(view.render(100));
  expect(expanded).toContain('  # Body');
  expect(expanded).toContain('  Instructions');
  expect(expanded.at(-1)).toBe('● 检查文档');
  expect(expanded.join('\n')).not.toContain('<skill');
});
