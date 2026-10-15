import { expect, test } from 'vitest';
import { toolResultContent } from '../../src/llm/tool-result.ts';
import type { ToolResultMessage } from '../../src/llm/types.ts';

function toolResult(partial: Partial<ToolResultMessage>): ToolResultMessage {
  return {
    role: 'tool_result',
    toolName: 'bash',
    toolCallId: 'call-1',
    output: '',
    timestamp: 1,
    ...partial,
  };
}

test('failure keeps both error and output visible to the model', () => {
  expect(
    toolResultContent(toolResult({ error: '命令失败', output: '部分输出' })),
  ).toBe('命令失败\n部分输出');
});

test('failure without output is just the error text', () => {
  expect(toolResultContent(toolResult({ error: '命令失败' }))).toBe('命令失败');
});

test('successful result is passed through as-is', () => {
  expect(toolResultContent(toolResult({ output: 'ok' }))).toBe('ok');
});
