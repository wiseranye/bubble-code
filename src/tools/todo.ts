import {
  type TodoInput,
  type TodoSnapshot,
  type TodoTask,
  todoInputSchema,
} from '../todo/todo.ts';
import { defineTool } from './schema.ts';
import type { ToolResult } from './types.ts';

export const todoTool = defineTool({
  name: 'todo',
  description: `Manage this session's todo list. Actions: create (one or several tasks), update (partial fields), list (optionally filter status or includeDeleted), get, delete (tombstone), clear (remove all tasks). Task ids are stable and never reused. Metadata updates are merged; a null value deletes its key. Deleted tasks are hidden by default. Completed tasks stay in the data; the UI hides previously completed tasks when a new prompt starts. Return to list or get when the current state is uncertain.`,
  inputSchema: todoInputSchema,
  isConcurrencySafe: input => {
    const parsed = todoInputSchema.safeParse(input);
    return (
      parsed.success &&
      (parsed.data.action === 'list' || parsed.data.action === 'get')
    );
  },
  async execute(input: TodoInput, context): Promise<ToolResult> {
    if (context.signal?.aborted) {
      return { success: false, output: '', error: 'user aborted' };
    }
    const store = context.todoStore;
    if (store === undefined) {
      return {
        success: false,
        output: '',
        error: 'TODO store is not connected to this session',
      };
    }

    // defineTool 只生成 JSON Schema，不做运行时 parse；模型输入必须在这里校验。
    const parsed = todoInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        output: '',
        error: parsed.error.issues
          .map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('\n'),
      };
    }

    try {
      switch (parsed.data.action) {
        case 'create':
          return successResult(
            'create',
            store.create(parsed.data.tasks),
            store.snapshot(),
          );
        case 'update':
          return successResult(
            'update',
            [store.update(parsed.data)],
            store.snapshot(),
          );
        case 'list':
          return successResult(
            'list',
            store.list(parsed.data.status, parsed.data.includeDeleted),
            store.snapshot(),
          );
        case 'get': {
          const task = store.get(parsed.data.id);
          if (task === undefined) {
            return {
              success: false,
              output: '',
              error: `TODO task not found: ${parsed.data.id}`,
            };
          }
          return successResult('get', [task], store.snapshot());
        }
        case 'delete':
          return successResult(
            'delete',
            [store.delete(parsed.data.id)],
            store.snapshot(),
          );
        case 'clear':
          return successResult('clear', store.clear(), store.snapshot());
      }
    } catch (error: unknown) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

function successResult(
  action: TodoInput['action'],
  tasks: TodoTask[],
  snapshot: TodoSnapshot,
): ToolResult {
  return {
    success: true,
    output: JSON.stringify(
      { action, tasks, summary: summarize(snapshot.todos) },
      null,
      2,
    ),
    metadata: { todoSnapshot: snapshot },
  };
}

function summarize(todos: readonly TodoTask[]): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  deleted: number;
} {
  const active = todos.filter(task => task.status !== 'deleted');
  return {
    total: active.length,
    pending: active.filter(task => task.status === 'pending').length,
    inProgress: active.filter(task => task.status === 'in_progress').length,
    completed: active.filter(task => task.status === 'completed').length,
    deleted: todos.length - active.length,
  };
}
