import { expect, test } from 'vitest';
import type { Skill, SkillActivation } from '../../src/agent/skills.ts';
import {
  matchSlashCommand,
  SlashCommandAutocomplete,
  type SlashCommandInvocation,
  type SlashSubmissionHandlers,
  slashCommandArgumentPlaceholder,
  slashCommandTakesArgument,
  submitSlashCommand,
} from '../../src/ui/slash-command.ts';

test('a bare argument-taking command gets a placeholder hint', () => {
  expect(slashCommandArgumentPlaceholder('/rename')).toBe(' <会话名称>');
  expect(slashCommandArgumentPlaceholder('/rename ')).toBe('<会话名称>');
  expect(slashCommandArgumentPlaceholder('/rename  ')).toBe('<会话名称>');
});

test('no placeholder once the argument is being typed', () => {
  expect(slashCommandArgumentPlaceholder('/rename 新')).toBeUndefined();
});

test('no placeholder for unknown commands or commands without arguments', () => {
  expect(slashCommandArgumentPlaceholder('/nope')).toBeUndefined();
  expect(slashCommandArgumentPlaceholder('/new')).toBeUndefined();
  expect(slashCommandArgumentPlaceholder('rename')).toBeUndefined();
  expect(slashCommandArgumentPlaceholder('')).toBeUndefined();
});

test('a bare argument-taking command matches with an empty argument', () => {
  // 提交拦截依赖这个约定：argument 为空时不执行，留在输入框继续编辑
  expect(matchSlashCommand('/rename')).toEqual({
    command: expect.objectContaining({ name: 'rename' }),
    argument: '',
  });
});

function skill(name: string): Skill {
  return {
    name,
    description: `Use ${name}`,
    location: `/tmp/${name}/SKILL.md`,
    body: `# ${name}`,
  };
}

test('skill commands accept optional text and prefer the longest known name', () => {
  const foo = skill('foo');
  const fooBar = skill('foo bar');

  expect(matchSlashCommand('/skill:foo', [foo])).toEqual({
    command: expect.objectContaining({
      name: 'skill:foo',
      argumentOptional: true,
      skill: foo,
    }),
    argument: '',
  });
  expect(matchSlashCommand('/skill:foo do work', [foo])?.argument).toBe(
    'do work',
  );
  expect(matchSlashCommand('/skill:foo bar details', [foo, fooBar])).toEqual({
    command: expect.objectContaining({ name: 'skill:foo bar', skill: fooBar }),
    argument: 'details',
  });
  expect(slashCommandTakesArgument('skill:foo')).toBe(true);
  expect(slashCommandArgumentPlaceholder('/skill:foo')).toBe(
    ' <额外描述（可选）>',
  );
});

test('skill autocomplete reads the current snapshot and completion stays editable', async () => {
  let skills = [skill('alpha')];
  const autocomplete = new SlashCommandAutocomplete(() => skills);

  const first = await autocomplete.getSuggestions(['/skill:'], 0, 7);
  expect(first?.items.map(item => item.value)).toEqual(['skill:alpha']);

  skills = [skill('beta')];
  const second = await autocomplete.getSuggestions(['/skill:'], 0, 7);
  expect(second?.items.map(item => item.value)).toEqual(['skill:beta']);
  expect(second?.items[0]?.description).toBe('Use beta');

  const item = second?.items[0];
  expect(item).toBeDefined();
  expect(
    autocomplete.applyCompletion(['/skill:'], 0, 7, item!, '/skill:'),
  ).toEqual({
    lines: ['/skill:beta '],
    cursorLine: 0,
    cursorCol: 12,
  });
});

type PromptCall = {
  text: string;
  activation: SkillActivation | undefined;
};

function submissionHarness(skills: readonly Skill[], busy = false) {
  const restored: string[] = [];
  const notifications: string[] = [];
  const prompts: PromptCall[] = [];
  const commands: SlashCommandInvocation[] = [];
  const handlers: SlashSubmissionHandlers = {
    skills,
    busy,
    restore: text => restored.push(text),
    notify: content => notifications.push(content),
    prompt: (text, activation) => prompts.push({ text, activation }),
    runCommand: invocation => commands.push(invocation),
  };
  return { handlers, restored, notifications, prompts, commands };
}

test('skill submission activates exactly once with optional description', () => {
  const foo = skill('foo');
  const harness = submissionHarness([foo]);

  submitSlashCommand('/skill:foo do work', harness.handlers);

  expect(harness.prompts).toHaveLength(1);
  expect(harness.commands).toHaveLength(0);
  expect(harness.restored).toHaveLength(0);
  expect(harness.prompts[0]).toEqual({
    text: '<skill name="foo" location="/tmp/foo/SKILL.md"># foo</skill>\n\ndo work',
    activation: {
      name: 'foo',
      location: '/tmp/foo/SKILL.md',
      body: '# foo',
      additionalDescription: 'do work',
    },
  });
});

test('bare skill submission activates without requiring extra description', () => {
  const harness = submissionHarness([skill('foo')]);

  submitSlashCommand('/skill:foo', harness.handlers);

  expect(harness.prompts).toHaveLength(1);
  expect(harness.prompts[0]?.activation?.additionalDescription).toBe('');
});

test('unknown and busy skill submissions restore text and warn without prompting', () => {
  const unknown = submissionHarness([skill('foo')]);
  submitSlashCommand('/skill:missing', unknown.handlers);
  expect(unknown.restored).toEqual(['/skill:missing']);
  expect(unknown.notifications).toEqual([
    '未找到匹配的 Skill，请从补全列表中选择',
  ]);
  expect(unknown.prompts).toHaveLength(0);

  const busy = submissionHarness([skill('foo')], true);
  submitSlashCommand('/skill:foo do work', busy.handlers);
  expect(busy.restored).toEqual(['/skill:foo do work']);
  expect(busy.notifications).toEqual(['请等待当前会话结束']);
  expect(busy.prompts).toHaveLength(0);
  expect(busy.commands).toHaveLength(0);
});
