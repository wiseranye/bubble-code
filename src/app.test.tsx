import test from 'ava';
import {cleanup, render} from 'ink-testing-library';
import React from 'react';
import {MockModel} from '@bubble-code/model/llm.js';
import App from './app.js';
import {Agent} from './agent/agent.js';
import {newToolRegistry} from './tools/index.js';

test.afterEach(() => {
  cleanup();
});

// Ink flushes passive effects (such as `useInput` subscribing to stdin) on
// the next macrotask, so give the renderer a tick before sending input.
async function flushEffects() {
  await new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

// Note: everything runs against a single `render()` call. Ink's renderer only
// flushes passive effects for the first render in a process, so a second
// `render()` (e.g. in a second test) would never receive input events.
test('renders the chat UI and accepts typed messages', async t => {
  const agent = new Agent({
    model: new MockModel(0),
    tools: newToolRegistry(),
  });
  const {stdin, stdout, lastFrame} = render(<App agent={agent} />);
  await flushEffects();

  // 历史和已定稿的消息走 <Static>，直接写进 stdout，不在动态帧里
  const written = stdout.frames.join('');
  t.true(written.includes('bubble-code'));
  t.true(written.includes('编码智能体'));

  // Backspace (many terminals send DEL, which Ink reports as `key.delete`)
  // should remove the character before the cursor.
  stdin.write('hellox');
  stdin.write('\u007F');

  let frame = lastFrame() ?? '';
  t.true(frame.includes('hello'));
  t.false(frame.includes('hellox'));

  // 回车之后用户消息定稿，会被 <Static> 写进终端 scrollback
  const framesBeforeSubmit = stdout.frames.length;
  stdin.write('\r');
  await flushEffects();

  t.true(stdout.frames.slice(framesBeforeSubmit).join('').includes('hello'));
});
