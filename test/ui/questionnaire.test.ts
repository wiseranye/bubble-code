import { stripTerminalSequences, type TUI } from '@earendil-works/pi-tui';
import { expect, test } from 'vitest';
import type {
  AskUserInput,
  QuestionnaireOutcome,
} from '../../src/tools/ask-user-input.ts';
import {
  hasVisibleAnswer,
  normalizeCustomAnswer,
  QuestionnaireView,
} from '../../src/ui/questionnaire.ts';

const enter = '\r';
const space = ' ';
const up = '\x1b[A';
const down = '\x1b[B';
const left = '\x1b[D';
const right = '\x1b[C';
const shiftEnter = '\x1b\r';

function questionInput(multiSelect = false): AskUserInput {
  return {
    questions: [
      {
        title: '任务类型',
        question: '今天想先做哪类任务？',
        multiSelect,
        options: [
          { label: '读代码', description: '先解释现有实现' },
          { label: '写功能', description: '直接编辑实现' },
        ],
      },
    ],
  };
}

function createView(input: AskUserInput) {
  const outcomes: QuestionnaireOutcome[] = [];
  const tui = {
    terminal: { rows: 40 },
    requestRender: () => undefined,
  } as unknown as TUI;
  const view = new QuestionnaireView(
    tui,
    input,
    outcome => outcomes.push(outcome),
    () => undefined,
  );
  view.focused = true;
  return { view, outcomes };
}

function render(view: QuestionnaireView): string {
  return stripTerminalSequences(view.render(100).join('\n'));
}

test('single-select changes its answer only on Enter and submits immediately', () => {
  const { view, outcomes } = createView(questionInput());
  view.handleInput(down);

  expect(render(view)).toContain('□ 任务类型');
  expect(outcomes).toEqual([]);
  view.handleInput(enter);

  expect(outcomes).toEqual([
    { status: 'submitted', answers: [{ values: ['写功能'] }] },
  ]);
});

test('single-select custom input supports multiline text and Enter confirmation', () => {
  const { view, outcomes } = createView(questionInput());
  view.handleInput(down);
  view.handleInput(down);
  view.handleInput(enter);
  view.handleInput('第一行');
  view.handleInput(shiftEnter);
  view.handleInput('第二行');
  view.handleInput(enter);

  expect(outcomes).toEqual([
    { status: 'submitted', answers: [{ values: ['第一行\n第二行'] }] },
  ]);
});

test('multi-select toggles in place and uses the final list item to submit', () => {
  const { view, outcomes } = createView(questionInput(true));
  view.handleInput(enter);
  expect(render(view)).toContain('[x] 读代码');
  expect(outcomes).toEqual([]);

  view.handleInput(enter);
  expect(render(view)).toContain('[ ] 读代码');
  expect(render(view)).toContain('□ 任务类型');

  view.handleInput(enter);
  view.handleInput(down);
  view.handleInput(space);
  view.handleInput(down);
  view.handleInput('  自定义答案  ');
  view.handleInput(enter);
  expect(outcomes).toEqual([]);
  expect(render(view)).toContain('› Submit answers');

  view.handleInput(enter);
  expect(outcomes).toEqual([
    {
      status: 'submitted',
      answers: [{ values: ['读代码', '写功能', '自定义答案'] }],
    },
  ]);
});

test('multi-select custom input is live and rejects invisible-only answers', () => {
  const { view, outcomes } = createView(questionInput(true));
  view.handleInput(down);
  view.handleInput(down);

  view.handleInput(space);
  view.handleInput('\u200b');
  expect(hasVisibleAnswer(' \t\n\u200b\ufeff')).toBe(false);
  expect(render(view)).toContain('[ ] Type something.');
  expect(render(view)).toContain('□ 任务类型');

  view.handleInput('有效');
  expect(render(view)).toContain('[x] Type something.');
  expect(render(view)).toContain('■ 任务类型');
  expect(outcomes).toEqual([]);
});

test('arrow up on the first custom-input line returns to the previous option', () => {
  const { view } = createView(questionInput(true));
  view.handleInput(down);
  view.handleInput(down);
  view.handleInput(up);
  view.handleInput(space);

  expect(render(view)).toContain('[x] 写功能');
});

test('multiple questions require review and keep the latest answers', () => {
  const input: AskUserInput = {
    questions: [
      questionInput().questions[0]!,
      {
        title: '收尾方式',
        question: '如何收尾？',
        options: [{ label: '仅检查' }, { label: '检查和说明' }],
      },
    ],
  };
  const { view, outcomes } = createView(input);

  view.handleInput(right);
  view.handleInput(right);
  expect(render(view)).toContain('Review your answers');
  view.handleInput(enter);
  expect(outcomes).toEqual([]);
  expect(render(view)).toContain('今天想先做哪类任务？');

  view.handleInput(enter);
  view.handleInput(down);
  view.handleInput(enter);
  expect(render(view)).toContain('Review your answers');
  expect(render(view)).toContain('● 任务类型');
  expect(render(view)).toContain('→ 读代码');
  expect(render(view)).toContain('→ 检查和说明');
  expect(outcomes).toEqual([]);

  view.handleInput(left);
  view.handleInput(up);
  view.handleInput(enter);
  expect(render(view)).toContain('→ 仅检查');
  view.handleInput(enter);
  expect(outcomes).toEqual([
    {
      status: 'submitted',
      answers: [{ values: ['读代码'] }, { values: ['仅检查'] }],
    },
  ]);
});

test('Escape cancels only the questionnaire', () => {
  const { view, outcomes } = createView(questionInput());
  view.handleInput('\x1b');
  expect(outcomes).toEqual([{ status: 'cancelled' }]);
});

test('custom answer normalization preserves internal whitespace', () => {
  expect(normalizeCustomAnswer('  第一行\n  第二行  ')).toBe(
    '第一行\n  第二行',
  );
  expect(hasVisibleAnswer('👩‍💻')).toBe(true);
  expect(hasVisibleAnswer('  有效  ')).toBe(true);
});
