import {setTimeout as sleep} from 'node:timers/promises';
import {type Message, type Response} from './message.js';
import {type Tool} from '@bubble-code/tools/tool.js';

// 调用模型时要声明的工具（模型只需要 schema，不需要 execute）
export type StreamOptions = {
  tools?: Tool[];
  signal?: AbortSignal;
};

export type Model = {
  stream(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncGenerator<Response>;
};

// A mock implementation used until a real model backend is wired up. It
// streams a canned reply token-by-token so the UI behaves like a real
// streaming agent.
export class MockModel implements Model {
  constructor(private readonly delay: number = 20) {}

  async *stream(messages: Message[]): AsyncGenerator<Response> {
    const last = messages[messages.length - 1];
    const reply = `mock reply: ${mockReply(last?.content ?? '')}`;

    for (const token of reply.split(/(\s+)/)) {
      if (token === '') {
        continue;
      }

      yield {type: 'text_delta', text: token};

      if (this.delay > 0) {
        // The per-token delay is intentional: it simulates streaming.
        // eslint-disable-next-line no-await-in-loop
        await sleep(this.delay);
      }
    }
  }
}

function mockReply(prompt: string): string {
  const preview = prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt;

  return [
    `收到：「${preview}」`,
    '',
    '这是 bubble-code 的模拟回复，用于演示对话窗口。',
    '',
    '目前还没有接入真实的模型后端。接下来会在这里接上 LLM，',
    '并逐步加入读取文件、执行命令、编辑代码等工具能力，',
    '让它成为一个真正的编码智能体。',
  ].join('\n');
}
