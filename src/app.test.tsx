import test from 'ava';
import {cleanup, render} from 'ink-testing-library';
import React from 'react';
import App from './app.js';
import {MockChatClient} from './llm.js';

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
	const {stdin, lastFrame} = render(<App client={new MockChatClient(0)} />);
	await flushEffects();

	let frame = lastFrame() ?? '';
	t.true(frame.includes('bubble-code'));
	t.true(frame.includes('编码智能体'));

	// Backspace (many terminals send DEL, which Ink reports as `key.delete`)
	// should remove the character before the cursor.
	stdin.write('hellox');
	stdin.write('\u007F');

	frame = lastFrame() ?? '';
	t.true(frame.includes('hello'));
	t.false(frame.includes('hellox'));

	stdin.write('\r');

	frame = lastFrame() ?? '';
	t.true(frame.includes('hello'));
});
