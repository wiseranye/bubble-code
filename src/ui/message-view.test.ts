import test from 'ava';
import {stripTerminalSequences} from '@earendil-works/pi-tui';
import {type ChatMessage} from '../chat-session.js';
import {peekHighlighted} from './highlight.js';
import {AssistantMessageView, createMessageView} from './message-view.js';

function plain(lines: string[]): string[] {
  return lines.map(line => stripTerminalSequences(line));
}

test('user message keeps the marker column and wraps continuations', t => {
  const view = createMessageView(
    {id: 1, role: 'user', content: '第一行\n第二行'},
    () => undefined,
  );
  const lines = plain(view.render(20));

  t.true(lines[0]?.startsWith('❯ 第一行'));
  t.is(lines[1], '  第二行');
});

test('assistant message renders markdown behind the marker', t => {
  const view = new AssistantMessageView('**你好**，世界', () => undefined);
  const lines = plain(view.render(30));

  t.true(lines[0]?.startsWith('✦ '));
  t.true(lines.join('\n').includes('你好，世界'));
});

test('sealing pre-computes syntax highlighting for code blocks', async t => {
  const code = 'const answer: number = 42;';
  const view = new AssistantMessageView(
    `示例：\n\n\`\`\`ts\n${code}\n\`\`\`\n`,
    () => undefined,
  );

  await view.seal();

  // 高亮已经进缓存，下次渲染就是带颜色的版本
  t.truthy(peekHighlighted(code, 'ts'));
  t.true(plain(view.render(60)).join('\n').includes(code));
});

test('async highlighting notifies the view to repaint', async t => {
  const code = 'const flag: boolean = true;';
  let ready = 0;
  const view = new AssistantMessageView(`\`\`\`ts\n${code}\n\`\`\``, () => {
    ready++;
  });

  // 首帧未命中缓存，同步返回纯文本并调度异步高亮
  view.render(60);
  await until(() => ready > 0);

  t.true(ready > 0);
});

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) {
      return;
    }

    // eslint-disable-next-line no-await-in-loop -- 轮询等待，本来就是顺序的
    await new Promise<void>(resolve => {
      setImmediate(resolve);
    });
  }

  throw new Error('condition not met');
}

test('tool message summarises input and caps output lines', t => {
  const output = Array.from({length: 10}, (_, index) => `line ${index + 1}`);
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

  t.true(lines[0]?.includes('⚙ bash'));
  t.true(text.includes('→ ls'));
  t.true(text.includes('line 8'));
  t.false(text.includes('line 9'));
  t.true(text.includes('… 还有 2 行输出'));
});

test('tool message updates in place when the call fails', t => {
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
  t.true(plain(view.render(40)).join('\n').includes('执行中'));

  view.update({
    ...running,
    status: 'done',
    success: false,
    output: 'boom',
  });

  const text = plain(view.render(40)).join('\n');
  t.true(text.includes('✗ bash'));
  t.false(text.includes('执行中'));
  t.true(text.includes('boom'));
});
