import { expect, test } from 'vitest';
import {
  createAskUserTool,
  formatQuestionnaireAnswers,
} from '../../src/tools/ask-user.ts';
import type {
  AskUserInput,
  QuestionnaireOutcome,
} from '../../src/tools/ask-user-input.ts';
import type { UiContext } from '../../src/ui/ui-context.ts';

const input: AskUserInput = {
  questions: [
    {
      title: '任务类型',
      question: '今天想先做哪类任务？',
      options: [{ label: '读代码' }, { label: '写功能' }],
    },
    {
      title: '验证方式',
      question: '需要哪些验证？',
      multiSelect: true,
      options: [{ label: '检查' }, { label: '测试' }],
    },
  ],
};

test('formats plain-text answers with original questions and multiline values', () => {
  const output = formatQuestionnaireAnswers(input, [
    { values: ['写功能'] },
    { values: ['检查', '自定义第一行\n  自定义第二行'] },
  ]);

  expect(output).toBe(`用户回答了你的问题：

问题 1：今天想先做哪类任务？
回答：写功能

问题 2：需要哪些验证？
回答：
- 检查
- 自定义第一行
    自定义第二行`);
});

test('maps UI submission, cancellation and abort to tool results', async () => {
  const tool = createAskUserTool();
  let outcome: QuestionnaireOutcome | undefined = { status: 'cancelled' };
  const ui: UiContext = {
    custom: <T>() => Promise.resolve(outcome as T),
    notify: () => undefined,
    setWidget: () => undefined,
  };
  const outcomes = [
    {
      status: 'submitted',
      answers: [{ values: ['读代码'] }, { values: ['测试'] }],
    },
    { status: 'cancelled' },
    { status: 'aborted' },
  ] as const;

  for (const nextOutcome of outcomes) {
    outcome = nextOutcome;
    const result = await tool.execute(input, { cwd: '/work/project', ui });
    if (nextOutcome.status === 'submitted') {
      expect(result.success).toBe(true);
      expect(result.output).toContain('用户回答了你的问题：');
      expect(result.output).toContain('回答：读代码');
    } else if (nextOutcome.status === 'cancelled') {
      expect(result).toEqual({
        success: false,
        output: '',
        error: '用户取消了回答',
      });
    } else {
      expect(result).toEqual({
        success: false,
        output: '',
        error: 'user aborted',
      });
    }
  }

  expect(tool.isConcurrencySafe(input)).toBe(false);
});

test('reports an unavailable UI without requiring CLI-specific wiring', async () => {
  const result = await createAskUserTool().execute(input, {
    cwd: '/work/project',
  });

  expect(result).toEqual({
    success: false,
    output: '',
    error: '交互式提问尚未连接到用户界面',
  });
});

test('does not enter the UI when the run was already aborted', async () => {
  let called = false;
  const tool = createAskUserTool();
  const ui: UiContext = {
    custom: () => {
      called = true;
      return Promise.resolve(undefined);
    },
    notify: () => undefined,
    setWidget: () => undefined,
  };
  const controller = new AbortController();
  controller.abort();

  const result = await tool.execute(input, {
    cwd: '/work/project',
    signal: controller.signal,
    ui,
  });

  expect(called).toBe(false);
  expect(result.error).toBe('user aborted');
});
