import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Agent } from '../../src/agent/agent.ts';
import { AgentSession } from '../../src/agent/agent-session.ts';
import { projectSessionEntries } from '../../src/agent/compaction.ts';
import type { SessionEntry } from '../../src/agent/session-manager.ts';
import { todoTool } from '../../src/tools/todo.ts';
import { ToolRegistry } from '../../src/tools/types.ts';
import type { UiContext } from '../../src/ui/ui-context.ts';

let bubbleHome: string;
const openSessions: AgentSession[] = [];

beforeEach(() => {
  bubbleHome = mkdtempSync(join(tmpdir(), 'bubble-todo-'));
  vi.stubEnv('BUBBLE_HOME', bubbleHome);
});

afterEach(async () => {
  await Promise.all(openSessions.map(session => session.dispose()));
  openSessions.length = 0;
  vi.unstubAllEnvs();
  rmSync(bubbleHome, { recursive: true, force: true });
});

function openSession(sessionFile?: string): {
  agent: Agent;
  session: AgentSession;
} {
  const agent = new Agent({ tools: new ToolRegistry() });
  const session = new AgentSession(agent, sessionFile);
  openSessions.push(session);
  return { agent, session };
}

function sessionFiles(): string[] {
  const sessionsRoot = join(bubbleHome, 'sessions');
  return readdirSync(sessionsRoot, { withFileTypes: true }).flatMap(
    directory => {
      if (!directory.isDirectory()) {
        return [];
      }
      const path = join(sessionsRoot, directory.name);
      return readdirSync(path)
        .filter(file => file.endsWith('.jsonl'))
        .map(file => join(path, file));
    },
  );
}

function onlySessionFile(): string {
  const files = sessionFiles();
  expect(files).toHaveLength(1);
  const file = files[0];
  if (file === undefined) {
    throw new Error('session file was not created');
  }
  return file;
}

function readEntries(file: string): SessionEntry[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as SessionEntry);
}

function todoPanel(session: AgentSession): {
  lines: () => string[];
  raw: () => string[] | undefined;
} {
  let current: string[] | undefined;
  const ui: UiContext = {
    custom: <T>() => Promise.resolve(undefined as T | undefined),
    notify: () => undefined,
    setWidget: (key, content) => {
      if (key === 'todo') {
        current = Array.isArray(content) ? content : undefined;
      }
    },
  };
  session.setUiContext(ui);
  return {
    lines: () => (current ?? []).map(line => stripTerminalSequences(line)),
    raw: () => current,
  };
}

test('appends a full snapshot for every mutation and resumes the latest state', async () => {
  const { agent, session } = openSession();
  agent.todoStore.create([
    {
      subject: '恢复我',
      description: '保留所有字段',
      activeForm: '正在恢复',
      status: 'in_progress',
      owner: 'agent-a',
      metadata: { source: 'test' },
    },
  ]);
  agent.todoStore.update({
    action: 'update',
    id: 1,
    status: 'completed',
  });

  // 查询和失败操作不产生新快照。
  await todoTool.execute(
    { action: 'list' },
    { cwd: '/tmp', todoStore: agent.todoStore },
  );
  await todoTool.execute(
    { action: 'update', id: 99, status: 'completed' },
    { cwd: '/tmp', todoStore: agent.todoStore },
  );
  await session.dispose();

  const file = onlySessionFile();
  const entries = readEntries(file);
  expect(entries.map(entry => entry.type)).toEqual([
    'metadata',
    'todo',
    'todo',
  ]);
  expect(entries[1]).toMatchObject({
    type: 'todo',
    nextId: 2,
    todos: [{ id: 1, status: 'in_progress' }],
  });
  expect(entries[2]).toMatchObject({
    type: 'todo',
    nextId: 2,
    todos: [{ id: 1, status: 'completed' }],
  });

  const restored = openSession(file);
  expect(restored.agent.todoStore.snapshot()).toEqual(
    agent.todoStore.snapshot(),
  );
  expect(restored.agent.state.messages).toEqual([]);

  const panel = todoPanel(restored.session);
  expect(panel.lines()).toEqual(['● Todos (1/1)', '└─ ✓ 恢复我']);
});

test('isolates new sessions and preserves ids after a persisted clear', async () => {
  const first = openSession();
  first.agent.todoStore.create([{ subject: '会话 A' }]);
  await first.session.dispose();
  const firstFile = onlySessionFile();

  const second = openSession();
  expect(second.agent.todoStore.snapshot()).toEqual({ todos: [], nextId: 1 });
  second.agent.todoStore.create([{ subject: '会话 B' }]);
  expect(second.agent.todoStore.snapshot().todos).toMatchObject([
    { id: 1, subject: '会话 B' },
  ]);
  await second.session.dispose();

  const restored = openSession(firstFile);
  expect(restored.agent.todoStore.snapshot().todos).toMatchObject([
    { id: 1, subject: '会话 A' },
  ]);
  restored.agent.todoStore.clear();
  await restored.session.dispose();

  const cleared = openSession(firstFile);
  expect(cleared.agent.todoStore.snapshot()).toEqual({ todos: [], nextId: 2 });
  cleared.agent.todoStore.create([{ subject: '新任务' }]);
  expect(cleared.agent.todoStore.snapshot().todos[0]?.id).toBe(2);
});

test('falls back to the latest valid snapshot or an empty store', async () => {
  const first = openSession();
  first.agent.todoStore.create([{ subject: '有效快照' }]);
  await first.session.dispose();
  const file = onlySessionFile();
  const invalid = `${JSON.stringify({ type: 'todo', id: 'bad', timestamp: 1, todos: [{ id: 2 }], nextId: 1 })}\n`;
  appendFileSync(file, invalid);

  const restored = openSession(file);
  expect(restored.agent.todoStore.snapshot().todos).toMatchObject([
    { id: 1, subject: '有效快照' },
  ]);

  const invalidOnlyFile = join(dirname(file), 'session-invalid-only.jsonl');
  writeFileSync(
    invalidOnlyFile,
    `${JSON.stringify({ type: 'metadata', id: 'invalid-only', cwd: '/tmp', version: 1, timestamp: 1 })}\n${invalid}`,
  );
  const empty = openSession(invalidOnlyFile);
  expect(empty.agent.todoStore.snapshot()).toEqual({ todos: [], nextId: 1 });
});

test('hides old completed tasks only in the UI at the next prompt', () => {
  const { agent, session } = openSession();
  agent.todoStore.create([
    { subject: '保留', status: 'pending' },
    { subject: '旧完成', status: 'completed' },
  ]);
  const panel = todoPanel(session);
  expect(panel.lines().join('\n')).toContain('旧完成');

  session.prompt('下一轮');
  expect(panel.lines()).toEqual(['● Todos (1/2)', '└─ ○ 保留']);
  expect(agent.todoStore.get(2)).toMatchObject({ status: 'completed' });

  // 本轮新完成的任务可见；重新打开旧任务后会解除隐藏。
  agent.todoStore.create([{ subject: '新完成', status: 'completed' }]);
  expect(panel.lines().join('\n')).toContain('新完成');
  expect(panel.lines().join('\n')).not.toContain('旧完成');
  agent.todoStore.update({ action: 'update', id: 2, status: 'pending' });
  expect(panel.lines().join('\n')).toContain('旧完成');

  agent.todoStore.clear();
  expect(panel.raw()).toBeUndefined();
});

test('todo entries do not enter context, transcript or compaction projections', () => {
  const entries: SessionEntry[] = [
    {
      type: 'metadata',
      id: 'session',
      cwd: '/tmp',
      version: 1,
      timestamp: 1,
    },
    {
      type: 'message',
      id: 'm1',
      timestamp: 2,
      message: { role: 'user', content: 'old', timestamp: 2 },
    },
    {
      type: 'todo',
      id: 't1',
      timestamp: 3,
      todos: [
        {
          id: 1,
          subject: 'task',
          description: '',
          status: 'completed',
        },
      ],
      nextId: 2,
    },
    {
      type: 'message',
      id: 'm2',
      timestamp: 4,
      message: { role: 'user', content: 'retained', timestamp: 4 },
    },
    {
      type: 'compaction',
      id: 'c1',
      timestamp: 5,
      summary: 'summary',
      summarizedCount: 1,
      firstRetainedEntryId: 'm2',
    },
    {
      type: 'todo',
      id: 't2',
      timestamp: 6,
      todos: [],
      nextId: 2,
    },
    {
      type: 'message',
      id: 'm3',
      timestamp: 7,
      message: { role: 'user', content: 'after', timestamp: 7 },
    },
  ];

  const projection = projectSessionEntries(entries);
  expect(projection.summary).toBe('summary');
  expect(projection.contextEntries.map(entry => entry.id)).toEqual([
    'm2',
    'm3',
  ]);
  expect(
    projection.transcript.map(item =>
      item.kind === 'message' ? item.entry.id : item.entry.id,
    ),
  ).toEqual(['m1', 'm2', 'c1', 'm3']);
});
