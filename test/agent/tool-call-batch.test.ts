import { expect, test } from 'vitest';
import * as z from 'zod';
import {
  executeToolCallBatch,
  skipToolCallBatch,
} from '../../src/agent/tool-call-batch.ts';
import type { AgentContext, AgentEvent } from '../../src/agent/types.ts';
import type { ToolCall } from '../../src/llm/types.ts';
import { defineTool } from '../../src/tools/schema.ts';
import {
  type ToolContext,
  ToolRegistry,
  type ToolResult,
} from '../../src/tools/types.ts';
import type { UiContext } from '../../src/ui/ui-context.ts';

type Input = { id: string };
type Execute = (input: Input) => Promise<ToolResult>;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

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

function call(id: string): ToolCall {
  return { type: 'tool_call', id, name: 'test', input: { id } };
}

function contextWith(
  isConcurrencySafe: (input: Input) => boolean,
  execute: Execute,
): AgentContext {
  const tools = new ToolRegistry();
  tools.register(
    defineTool({
      name: 'test',
      description: 'test',
      inputSchema: z.object({ id: z.string() }),
      isConcurrencySafe,
      execute,
    }),
  );
  return { tools, cwd: '/tmp', messages: [] };
}

function resultIds(events: readonly AgentEvent[]): string[] {
  return events.flatMap(event =>
    event.type === 'tool_result' ? [event.toolCallId] : [],
  );
}

test('passes call-specific id and session UI into each tool execution', async () => {
  const ui: UiContext = {
    custom: () => Promise.resolve(undefined),
    notify: () => undefined,
    setWidget: () => undefined,
  };
  const tools = new ToolRegistry();
  let seen: ToolContext | undefined;
  tools.register(
    defineTool({
      name: 'test',
      description: 'test',
      inputSchema: z.object({ id: z.string() }),
      isConcurrencySafe: () => true,
      execute: async (_input, context) => {
        seen = context;
        return { success: true, output: 'ok' };
      },
    }),
  );

  await executeToolCallBatch([call('call-1')], {
    context: { tools, cwd: '/tmp', messages: [], ui },
    maxConcurrentCalls: 1,
    emit: () => undefined,
  });

  expect(seen).toMatchObject({ toolCallId: 'call-1', cwd: '/tmp', ui });
});

test('safe calls roll into freed slots and return results in declaration order', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const gates = new Map(ids.map(id => [id, deferred()]));
  const started: string[] = [];
  let active = 0;
  let maxActive = 0;
  const context = contextWith(
    () => true,
    async ({ id }) => {
      started.push(id);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await gates.get(id)?.promise;
        return { success: true, output: id };
      } finally {
        active--;
      }
    },
  );
  const events: AgentEvent[] = [];

  const running = executeToolCallBatch(
    ids.map(id => call(id)),
    {
      context,
      maxConcurrentCalls: 2,
      emit: event => {
        events.push(event);
      },
    },
  );
  await until(() => started.length === 2);
  expect(started).toEqual(['a', 'b']);
  expect(maxActive).toBe(2);

  gates.get('b')?.resolve();
  await until(() => started.includes('c'));
  expect(started).toEqual(['a', 'b', 'c']);
  const bResult = events.findIndex(
    event => event.type === 'tool_result' && event.toolCallId === 'b',
  );
  const cStart = events.findIndex(
    event => event.type === 'tool_start' && event.toolCall.id === 'c',
  );
  expect(cStart).toBeGreaterThan(bResult);

  for (const gate of gates.values()) {
    gate.resolve();
  }
  const results = await running;

  expect(maxActive).toBe(2);
  expect(results.map(result => result.toolCallId)).toEqual(ids);
  expect(resultIds(events)[0]).toBe('b');
});

test('one unsafe call makes the whole batch serial', async () => {
  const started: string[] = [];
  let active = 0;
  let maxActive = 0;
  const context = contextWith(
    ({ id }) => id !== 'b',
    async ({ id }) => {
      started.push(id);
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return { success: true, output: id };
    },
  );

  const results = await executeToolCallBatch(
    ['a', 'b', 'c'].map(id => call(id)),
    {
      context,
      maxConcurrentCalls: 3,
      emit: () => {},
    },
  );

  expect(started).toEqual(['a', 'b', 'c']);
  expect(maxActive).toBe(1);
  expect(results.map(result => result.toolCallId)).toEqual(['a', 'b', 'c']);
});

test('a throwing safety predicate conservatively forces serial execution', async () => {
  let active = 0;
  let maxActive = 0;
  const context = contextWith(
    ({ id }) => {
      if (id === 'a') {
        throw new Error('bad predicate');
      }
      return true;
    },
    async ({ id }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return { success: true, output: id };
    },
  );

  await executeToolCallBatch(
    ['a', 'b'].map(id => call(id)),
    {
      context,
      maxConcurrentCalls: 2,
      emit: () => {},
    },
  );

  expect(maxActive).toBe(1);
});

test('abort settles started calls and completes queued calls with user aborted', async () => {
  const ids = ['a', 'b', 'c'];
  const gates = new Map(ids.map(id => [id, deferred()]));
  const started: string[] = [];
  const context = contextWith(
    () => true,
    async ({ id }) => {
      started.push(id);
      await gates.get(id)?.promise;
      return { success: true, output: `actual ${id}` };
    },
  );
  const controller = new AbortController();
  const events: AgentEvent[] = [];

  const running = executeToolCallBatch(
    ids.map(id => call(id)),
    {
      context,
      signal: controller.signal,
      maxConcurrentCalls: 2,
      emit: event => {
        events.push(event);
      },
    },
  );
  await until(() => started.length === 2);
  controller.abort();
  gates.get('a')?.resolve();
  gates.get('b')?.resolve();
  const results = await running;

  expect(started).toEqual(['a', 'b']);
  expect(results.map(result => result.toolCallId)).toEqual(ids);
  expect(results[0]?.output).toBe('actual a');
  expect(results[1]?.output).toBe('actual b');
  expect(results[2]).toMatchObject({
    toolCallId: 'c',
    output: '',
    error: 'user aborted',
  });
  expect(resultIds(events).sort()).toEqual(ids);
  for (const id of ids) {
    expect(resultIds(events).filter(resultId => resultId === id)).toHaveLength(
      1,
    );
  }
});

test('skipToolCallBatch preserves every complete call without starting tools', async () => {
  const events: AgentEvent[] = [];
  const results = await skipToolCallBatch(
    ['a', 'b'].map(id => call(id)),
    'model response failed; tool call was not executed',
    event => {
      events.push(event);
    },
  );

  expect(results.map(result => result.toolCallId)).toEqual(['a', 'b']);
  expect(
    results.every(
      result =>
        result.error === 'model response failed; tool call was not executed' &&
        result.output === '',
    ),
  ).toBe(true);
  expect(resultIds(events)).toEqual(['a', 'b']);
  expect(events.some(event => event.type === 'tool_start')).toBe(false);
});
