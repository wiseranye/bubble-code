import { setTimeout as sleep } from 'node:timers/promises';
import { type Tool } from '@bubble-code/tools/tool.js';
import type {
  AssistantMessage,
  Message,
  StreamChunkEvent,
  Text,
} from 'src/agent/types.js';
import { EventStream } from 'src/utils/event-stream.js';
// 调用模型时要声明的工具（模型只需要 schema，不需要 execute）
export type StreamOptions = {
  tools?: Tool[];
  signal?: AbortSignal;
};

export type Model = {
  stream(
    messages: Message[],
    options?: StreamOptions,
  ): AssistantMessageEventStream;
};

export class AssistantMessageEventStream extends EventStream<
  StreamChunkEvent,
  AssistantMessage
> {
  constructor() {
    super(
      // 什么时候流结束？
      event => event.type === 'done' || event.type === 'error',
      // 怎么组装最终结果
      event => {
        if (event.type === 'done' || event.type === 'error') {
          return event.message;
        }

        throw new Error('Unexpected event type for final result');
      },
    );
  }
}

// A mock implementation used until a real model backend is wired up. It
// streams a canned reply token-by-token so the UI behaves like a real
// streaming agent.
export class MockModel implements Model {
  constructor(private readonly delay: number = 20) {}

  stream(_: Message[]): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();

    (async () => {
      const output: AssistantMessage = {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
        timestamp: Date.now(),
      };

      const reply = `mock reply: 这是虚假的回复`;
      const block: Text = { type: 'text', text: '' };
      output.content.push(block);

      stream.push({ type: 'start', partial: output });
      stream.push({ type: 'text_start', index: 0, partial: output });

      for (const token of reply.split(/(\s+)/)) {
        if (token === '') {
          continue;
        }

        block.text += token;

        stream.push({
          type: 'text_delta',
          index: 0,
          delta: token,
          partial: output,
        });

        if (this.delay > 0) {
          // The per-token delay is intentional: it simulates streaming.
          // eslint-disable-next-line no-await-in-loop
          await sleep(this.delay);
        }
      }

      stream.push({ type: 'text_end', index: 0, text: block, partial: output });
      stream.push({ type: 'done', reason: 'stop', message: output });
      stream.end();
    })();

    return stream;
  }
}
