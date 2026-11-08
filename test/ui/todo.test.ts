import { stripTerminalSequences } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { expect, test } from 'vitest';
import type { TodoTask } from '../../src/todo/todo.ts';
import { renderTodoLines } from '../../src/ui/todo.ts';

chalk.level = 1;

const tasks: TodoTask[] = [
  {
    id: 1,
    subject: '待处理',
    description: '',
    status: 'pending',
  },
  {
    id: 2,
    subject: '进行中',
    description: '',
    activeForm: '正在处理',
    status: 'in_progress',
  },
  {
    id: 3,
    subject: '已完成',
    description: '',
    activeForm: '不会显示',
    status: 'completed',
  },
  {
    id: 4,
    subject: '已删除',
    description: '',
    status: 'deleted',
  },
  {
    id: 5,
    subject: '最后一项',
    description: '',
    status: 'pending',
  },
];

function plainLines(hiddenCompletedIds?: ReadonlySet<number>): string[] {
  return renderTodoLines(tasks, hiddenCompletedIds).map(line =>
    stripTerminalSequences(line),
  );
}

test('renders progress, tree lines, status icons and active forms', () => {
  expect(plainLines()).toEqual([
    '● Todos (1/4)',
    '├─ ○ 待处理',
    '├─ ◉ 进行中 (正在处理)',
    '├─ ✓ 已完成',
    '└─ ○ 最后一项',
  ]);
});

test('hides selected completed tasks without changing the overall count', () => {
  expect(plainLines(new Set([3]))).toEqual([
    '● Todos (1/4)',
    '├─ ○ 待处理',
    '├─ ◉ 进行中 (正在处理)',
    '└─ ○ 最后一项',
  ]);
});

test('hides the panel when no visible tasks remain', () => {
  expect(renderTodoLines([])).toEqual([]);
  expect(
    renderTodoLines(
      [
        {
          id: 1,
          subject: '已完成',
          description: '',
          status: 'completed',
        },
      ],
      new Set([1]),
    ),
  ).toEqual([]);
});

test('omits empty active forms', () => {
  const [header, task] = plainLines();
  expect(header).toContain('Todos');
  expect(task).not.toContain('undefined');

  const lines = renderTodoLines([
    {
      id: 1,
      subject: '空白活动文案',
      description: '',
      activeForm: '   ',
      status: 'in_progress',
    },
    {
      id: 2,
      subject: '无活动文案',
      description: '',
      status: 'in_progress',
    },
  ]).map(line => stripTerminalSequences(line));
  expect(lines[1]).toBe('├─ ◉ 空白活动文案');
  expect(lines[2]).toBe('└─ ◉ 无活动文案');
});
