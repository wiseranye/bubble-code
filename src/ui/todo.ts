import chalk from 'chalk';
import type { TodoTask } from '../todo/todo.ts';
import { style } from './theme.ts';

// 只读投影：隐藏已完成任务不会修改 store，也不会产生新的会话快照。
export function renderTodoLines(
  todos: readonly TodoTask[],
  hiddenCompletedIds: ReadonlySet<number> = new Set(),
): string[] {
  const tasks = todos.filter(task => task.status !== 'deleted');
  const visible = tasks.filter(
    task => !(task.status === 'completed' && hiddenCompletedIds.has(task.id)),
  );
  if (visible.length === 0) {
    return [];
  }

  const completed = tasks.filter(task => task.status === 'completed').length;
  const lines = [
    `${chalk.magenta('●')}${chalk.bold(` Todos (${completed}/${tasks.length})`)}`,
  ];
  for (const [index, task] of visible.entries()) {
    const branch = index === visible.length - 1 ? '└─' : '├─';
    const activeForm =
      task.status === 'in_progress' &&
      task.activeForm !== undefined &&
      task.activeForm.trim() !== ''
        ? ` (${task.activeForm.trim()})`
        : '';
    lines.push(
      `${style.dim(branch)} ${statusIcon(task.status)} ${task.subject}${style.running(activeForm)}`,
    );
  }
  return lines;
}

function statusIcon(status: TodoTask['status']): string {
  switch (status) {
    case 'pending':
      return style.dim('○');
    case 'in_progress':
      return style.running('◉');
    case 'completed':
      return chalk.green('✓');
    case 'deleted':
      return '';
  }
}
