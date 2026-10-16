import { expect, test } from 'vitest';
import {
  matchSlashCommand,
  slashCommandArgumentPlaceholder,
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
