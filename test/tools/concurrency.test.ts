import { expect, test } from 'vitest';
import { newToolRegistry } from '../../src/tools/index.ts';

test('built-in tools declare conservative concurrency safety', () => {
  const safety = Object.fromEntries(
    newToolRegistry()
      .list()
      .map(tool => [tool.name, tool.isConcurrencySafe({})]),
  );

  expect(safety).toEqual({
    bash: false,
    read: true,
    edit: false,
    write: false,
    find: true,
    grep: true,
    ask_user: false,
  });
});
