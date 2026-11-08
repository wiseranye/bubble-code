import * as z from 'zod';

export const todoStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'deleted',
]);

const todoMetadataSchema = z.record(z.string(), z.json());
type TodoMetadata = z.infer<typeof todoMetadataSchema>;

export const todoTaskSchema = z.object({
  id: z.number().int().positive(),
  subject: z.string().trim().min(1),
  description: z.string(),
  activeForm: z.string().optional(),
  status: todoStatusSchema,
  owner: z.string().optional(),
  metadata: todoMetadataSchema.optional(),
});

export type TodoStatus = z.infer<typeof todoStatusSchema>;
export type TodoTask = z.infer<typeof todoTaskSchema>;

export const todoSnapshotSchema = z
  .object({
    todos: z.array(todoTaskSchema),
    nextId: z.number().int().positive(),
  })
  .superRefine((snapshot, context) => {
    const ids = new Set<number>();
    for (const [index, task] of snapshot.todos.entries()) {
      if (ids.has(task.id)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate task id: ${task.id}`,
          path: ['todos', index, 'id'],
        });
      }
      ids.add(task.id);
      if (task.id >= snapshot.nextId) {
        context.addIssue({
          code: 'custom',
          message: 'nextId must be greater than every task id',
          path: ['nextId'],
        });
      }
    }
  });

export type TodoSnapshot = z.infer<typeof todoSnapshotSchema>;

export const todoCreateItemSchema = z.object({
  subject: z.string().trim().min(1),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed']).optional(),
  owner: z.string().optional(),
  metadata: todoMetadataSchema.optional(),
});

export type TodoCreateItem = z.infer<typeof todoCreateItemSchema>;

export const todoUpdateInputSchema = z.object({
  action: z.literal('update'),
  id: z.number().int().positive(),
  subject: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  status: todoStatusSchema.optional(),
  owner: z.string().optional(),
  metadata: todoMetadataSchema.optional(),
});

export type TodoUpdateInput = z.infer<typeof todoUpdateInputSchema>;

export const todoInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    tasks: z.array(todoCreateItemSchema).min(1),
  }),
  todoUpdateInputSchema,
  z.object({
    action: z.literal('list'),
    status: todoStatusSchema.optional(),
    includeDeleted: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('get'),
    id: z.number().int().positive(),
  }),
  z.object({
    action: z.literal('delete'),
    id: z.number().int().positive(),
  }),
  z.object({ action: z.literal('clear') }),
]);

export type TodoInput = z.infer<typeof todoInputSchema>;

type TodoListener = (snapshot: TodoSnapshot) => void;

// 每个 Agent 持有一个 store。快照监听器负责会话落盘和 UI 投影，工具本身不持有状态。
export class TodoStore {
  private tasks: TodoTask[];
  private nextId: number;
  private readonly listeners: Set<TodoListener>;

  constructor() {
    this.tasks = [];
    this.nextId = 1;
    this.listeners = new Set();
  }

  snapshot(): TodoSnapshot {
    return structuredClone({ todos: this.tasks, nextId: this.nextId });
  }

  list(status?: TodoStatus, includeDeleted = false): TodoTask[] {
    const tasks = this.tasks.filter(
      task =>
        (includeDeleted || task.status !== 'deleted') &&
        (status === undefined || task.status === status),
    );
    return structuredClone(tasks);
  }

  get(id: number): TodoTask | undefined {
    const task = this.tasks.find(candidate => candidate.id === id);
    return task === undefined ? undefined : structuredClone(task);
  }

  create(items: readonly TodoCreateItem[]): TodoTask[] {
    const created = items.map(item => ({
      id: this.nextId++,
      subject: item.subject,
      description: item.description ?? '',
      ...(item.activeForm === undefined ? {} : { activeForm: item.activeForm }),
      status: item.status ?? 'pending',
      ...(item.owner === undefined ? {} : { owner: item.owner }),
      ...(item.metadata === undefined
        ? {}
        : { metadata: structuredClone(item.metadata) }),
    }));
    this.tasks.push(...created);
    this.emit();
    return structuredClone(created);
  }

  update(input: TodoUpdateInput): TodoTask {
    const index = this.tasks.findIndex(task => task.id === input.id);
    const current = this.tasks[index];
    if (current === undefined) {
      throw new Error(`TODO task not found: ${input.id}`);
    }

    const updated: TodoTask = {
      ...current,
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      ...(input.activeForm === undefined
        ? {}
        : { activeForm: input.activeForm }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.owner === undefined ? {} : { owner: input.owner }),
      ...(input.metadata === undefined
        ? {}
        : { metadata: mergeMetadata(current.metadata, input.metadata) }),
    };
    this.tasks[index] = updated;
    this.emit();
    return structuredClone(updated);
  }

  delete(id: number): TodoTask {
    return this.update({ action: 'update', id, status: 'deleted' });
  }

  clear(): TodoTask[] {
    const cleared = structuredClone(this.tasks);
    this.tasks = [];
    this.emit();
    return cleared;
  }

  // 恢复只替换内存，不触发监听器，避免把读到的快照再写回会话文件。
  hydrate(snapshot: TodoSnapshot): void {
    const parsed = todoSnapshotSchema.parse(snapshot);
    this.tasks = structuredClone(parsed.todos);
    this.nextId = parsed.nextId;
  }

  subscribe(listener: TodoListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

function mergeMetadata(
  current: TodoMetadata | undefined,
  updates: TodoMetadata,
): TodoMetadata {
  const merged = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}
