import { expect, test } from 'vitest';
import { type TodoInput, TodoStore } from '../../src/todo/todo.ts';
import { todoTool } from '../../src/tools/todo.ts';

function execute(store: TodoStore, input: TodoInput) {
  return todoTool.execute(input, { cwd: '/tmp', todoStore: store });
}

test('creates complete tasks and returns model-visible results and snapshots', async () => {
  const store = new TodoStore();
  const result = await execute(store, {
    action: 'create',
    tasks: [
      {
        subject: '  实现 TODO  ',
        description: '接入会话与面板',
        activeForm: '正在实现 TODO',
        status: 'in_progress',
        owner: 'agent-a',
        metadata: { area: 'tools', nullable: null },
      },
      { subject: '运行检查' },
    ],
  });

  expect(result.success).toBe(true);
  expect(store.snapshot()).toEqual({
    todos: [
      {
        id: 1,
        subject: '实现 TODO',
        description: '接入会话与面板',
        activeForm: '正在实现 TODO',
        status: 'in_progress',
        owner: 'agent-a',
        metadata: { area: 'tools', nullable: null },
      },
      {
        id: 2,
        subject: '运行检查',
        description: '',
        status: 'pending',
      },
    ],
    nextId: 3,
  });
  expect(result.metadata).toEqual({ todoSnapshot: store.snapshot() });
  const output = JSON.parse(result.output) as {
    action: string;
    tasks: unknown[];
    summary: { total: number; inProgress: number };
  };
  expect(output.action).toBe('create');
  expect(output.tasks).toHaveLength(2);
  expect(output.summary).toMatchObject({ total: 2, inProgress: 1 });
});

test('validates the whole create batch before changing state', async () => {
  const store = new TodoStore();
  const result = await execute(store, {
    action: 'create',
    tasks: [{ subject: '有效任务' }, { subject: '   ' }],
  });

  expect(result.success).toBe(false);
  expect(result.error).toContain('tasks.1.subject');
  expect(store.snapshot()).toEqual({ todos: [], nextId: 1 });
});

test('updates fields, merges metadata and deletes null-valued keys', async () => {
  const store = new TodoStore();
  store.create([
    {
      subject: '旧标题',
      metadata: { keep: 1, remove: 2 },
      status: 'in_progress',
    },
  ]);

  const result = await execute(store, {
    action: 'update',
    id: 1,
    subject: '新标题',
    status: 'completed',
    metadata: { remove: null, added: { enabled: true } },
  });

  expect(result.success).toBe(true);
  expect(store.get(1)).toMatchObject({
    subject: '新标题',
    status: 'completed',
    metadata: { keep: 1, added: { enabled: true } },
  });
});

test('supports multiple active tasks, tombstones, filtering and reopening', async () => {
  const store = new TodoStore();
  store.create([
    { subject: 'A', status: 'in_progress' },
    { subject: 'B', status: 'in_progress' },
  ]);
  expect(store.list('in_progress')).toHaveLength(2);

  await execute(store, { action: 'delete', id: 1 });
  expect(store.list()).toMatchObject([{ id: 2 }]);
  expect(store.list(undefined, true)).toHaveLength(2);
  expect(store.get(1)).toMatchObject({ id: 1, status: 'deleted' });

  const reopened = await execute(store, {
    action: 'update',
    id: 1,
    status: 'pending',
  });
  expect(reopened.success).toBe(true);
  expect(store.get(1)).toMatchObject({ id: 1, status: 'pending' });
});

test('clear preserves the monotonic id counter', async () => {
  const store = new TodoStore();
  store.create([{ subject: 'A' }, { subject: 'B' }]);

  const cleared = await execute(store, { action: 'clear' });
  expect(cleared.success).toBe(true);
  expect(store.snapshot()).toEqual({ todos: [], nextId: 3 });

  await execute(store, { action: 'create', tasks: [{ subject: 'C' }] });
  expect(store.get(3)).toMatchObject({ id: 3, subject: 'C' });
  expect(store.get(1)).toBeUndefined();
});

test('queries are concurrency-safe and mutations are serial', () => {
  expect(todoTool.isConcurrencySafe({ action: 'list' })).toBe(true);
  expect(todoTool.isConcurrencySafe({ action: 'get', id: 1 })).toBe(true);
  expect(todoTool.isConcurrencySafe({ action: 'clear' })).toBe(false);
  expect(todoTool.isConcurrencySafe({ action: 'delete', id: 1 })).toBe(false);
});

test('rejects aborted calls, missing stores and unknown tasks without mutation', async () => {
  const store = new TodoStore();
  const aborted = await todoTool.execute(
    { action: 'clear' },
    { cwd: '/tmp', todoStore: store, signal: AbortSignal.abort() },
  );
  expect(aborted).toEqual({
    success: false,
    output: '',
    error: 'user aborted',
  });

  const disconnected = await todoTool.execute(
    { action: 'list' },
    { cwd: '/tmp' },
  );
  expect(disconnected.success).toBe(false);

  const missing = await execute(store, { action: 'get', id: 99 });
  expect(missing).toEqual({
    success: false,
    output: '',
    error: 'TODO task not found: 99',
  });
  expect(store.snapshot()).toEqual({ todos: [], nextId: 1 });
});

test('input schema has no dependency fields', () => {
  expect(JSON.stringify(todoTool.inputSchema)).not.toContain('blockedBy');
});
