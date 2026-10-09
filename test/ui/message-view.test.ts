import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { expect, test } from 'vitest';
import type { ChatMessage } from '../../src/agent/agent-session.ts';
import { peekHighlighted } from '../../src/ui/highlight.ts';
import {
  AssistantMessageView,
  createMessageView,
} from '../../src/ui/message-view.ts';

function plain(lines: string[]): string[] {
  return lines.map(line => stripTerminalSequences(line));
}

test('user message keeps the marker column and wraps continuations', () => {
  const view = createMessageView(
    { id: 1, role: 'user', content: '第一行\n第二行' },
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

test('tool message summarises input and caps output lines', () => {
  const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  const message: ChatMessage = {
    id: 2,
    role: 'tool',
    toolCallId: 'call-1',
    name: 'bash',
    input: '{"command":"ls"}',
    output: output.join('\n'),
    status: 'done',
    success: true,
  };
  const view = createMessageView(message, () => undefined);
  const lines = plain(view.render(40));
  const text = lines.join('\n');

  expect(lines[0]?.includes('⚙ bash')).toBe(true);
  expect(text.includes('→ ls')).toBe(true);
  expect(text.includes('line 8')).toBe(true);
  expect(text.includes('line 9')).toBe(false);
  expect(text.includes('… 还有 2 行输出')).toBe(true);
});

test('tool message updates in place when the call fails', () => {
  const running: ChatMessage = {
    id: 3,
    role: 'tool',
    toolCallId: 'call-2',
    name: 'bash',
    input: '{"command":"false"}',
    output: '',
    status: 'running',
    success: true,
  };
  const view = createMessageView(running, () => undefined);
  expect(plain(view.render(40)).join('\n').includes('执行中')).toBe(true);

  view.update({
    ...running,
    status: 'done',
    success: false,
    output: 'boom',
  });

  const text = plain(view.render(40)).join('\n');
  expect(text.includes('✗ bash')).toBe(true);
  expect(text.includes('执行中')).toBe(false);
  expect(text.includes('boom')).toBe(true);
});
