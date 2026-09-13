import test from 'ava';
import {
  MockModel,
  type Model,
  type StreamOptions,
} from '@bubble-code/model/llm.js';
import {type Message, type Response} from '@bubble-code/model/message.js';
import {ToolRegistry} from '@bubble-code/tools/tool.js';
import {Agent} from './agent/agent.js';
import {
  ChatSession,
  type ChatSessionEvent,
  type TextChatMessage,
  type ToolChatMessage,
} from './chat-session.js';

// 等条件成立，最多让出若干轮事件循环
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) {
      return;
    }

    // eslint-disable-next-line no-await-in-loop -- 轮询等待，本来就是顺序的
    await new Promise<void>(resolve => {
      setImmediate(resolve);
    });
  }

  throw new Error('condition not met');
}

function record(session: ChatSession): ChatSessionEvent[] {
  const events: ChatSessionEvent[] = [];
  session.subscribe(event => events.push(event));
  return events;
}

function streamingFlags(events: ChatSessionEvent[]): boolean[] {
  return events.flatMap(event =>
    event.type === 'streaming_changed' ? [event.isStreaming] : [],
  );
}

test('streams assistant text and seals both messages', async t => {
  const agent = new Agent({model: new MockModel(0), tools: new ToolRegistry()});
  const session = new ChatSession(agent);
  const events = record(session);

  t.is(session.messages.length, 1);
  t.is(session.messages[0]?.role, 'system');

  session.send('你好');
  t.true(session.isStreaming);

  await until(() => !session.isStreaming);

  // 用户消息：added 后立刻 sealed
  t.true(
    events.some(
      event => event.type === 'message_added' && event.message.role === 'user',
    ),
  );
  t.true(
    events.some(
      event => event.type === 'message_sealed' && event.message.role === 'user',
    ),
  );

  // 助手消息：added（首个增量）→ updated（后续增量）→ sealed（收尾）
  const assistant = session.messages.find(
    (message): message is TextChatMessage => message.role === 'assistant',
  );
  t.truthy(assistant);
  t.true((assistant?.content ?? '').includes('mock reply'));
  t.true(
    events.some(
      event =>
        event.type === 'message_updated' && event.message.role === 'assistant',
    ),
  );
  t.true(
    events.some(
      event =>
        event.type === 'message_sealed' && event.message.role === 'assistant',
    ),
  );

  // Streaming 开关严格成对
  t.deepEqual(streamingFlags(events), [true, false]);
});

test('running a tool creates a tool message that is updated and sealed', async t => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: 'echo',
    inputSchema: {},
    async execute(input: Record<string, unknown>) {
      return {success: true, output: `ok: ${String(input['value'])}`};
    },
  });

  const model = new ScriptedModel([
    [
      {type: 'text_delta', text: '让我看看。'},
      {
        type: 'tool_call',
        toolCall: {
          id: 'call-1',
          name: 'echo',
          input: {value: 'hi'},
          inputRaw: '{"value":"hi"}',
        },
      },
    ],
    [{type: 'text_delta', text: '完成了。'}],
  ]);
  const agent = new Agent({model, tools: registry});
  const session = new ChatSession(agent);
  const events = record(session);

  session.send('跑一下');
  await until(() => !session.isStreaming);

  const tools = session.messages.filter(
    (message): message is ToolChatMessage => message.role === 'tool',
  );
  t.is(tools.length, 1);
  t.is(tools[0]?.status, 'done');
  t.true(tools[0]?.success);
  t.is(tools[0]?.output, 'ok: hi');

  // 工具开始前，前一段文本已冻结；工具结果回来后再冻结工具消息
  t.true(
    events.some(
      event =>
        event.type === 'message_sealed' &&
        event.message.role === 'assistant' &&
        event.message.content === '让我看看。',
    ),
  );
  t.true(
    events.some(
      event => event.type === 'message_sealed' && event.message.role === 'tool',
    ),
  );

  // 工具调用之后的文本是新的一条助手消息
  const assistants = session.messages.filter(
    (message): message is TextChatMessage => message.role === 'assistant',
  );
  t.is(assistants.length, 2);
  t.is(assistants[1]?.content, '完成了。');
});

test('cancel seals the partial assistant text without error text', async t => {
  const agent = new Agent({
    model: new HangingModel(),
    tools: new ToolRegistry(),
  });
  const session = new ChatSession(agent);
  const events = record(session);

  session.send('开始');
  await until(() =>
    session.messages.some(message => message.role === 'assistant'),
  );

  session.cancel();
  await until(() => !session.isStreaming);

  const assistant = session.messages.find(
    (message): message is TextChatMessage => message.role === 'assistant',
  );
  t.is(assistant?.content, 'partial');
  t.false((assistant?.content ?? '').includes('生成出错'));
  t.true(
    events.some(
      event =>
        event.type === 'message_sealed' && event.message.role === 'assistant',
    ),
  );
});

test('send is ignored while generating and for empty input', async t => {
  const agent = new Agent({
    model: new HangingModel(),
    tools: new ToolRegistry(),
  });
  const session = new ChatSession(agent);

  session.send('   ');
  t.false(session.isStreaming);

  session.send('第一次');
  t.true(session.isStreaming);
  session.send('第二次');
  t.is(session.messages.filter(message => message.role === 'user').length, 1);

  session.cancel();
  await until(() => !session.isStreaming);
});

class ScriptedModel implements Model {
  private index = 0;

  constructor(private readonly script: Response[][]) {}

  async *stream(
    _messages: Message[],
    _options?: StreamOptions,
  ): AsyncGenerator<Response> {
    const step = this.script[this.index++] ?? [];
    for (const response of step) {
      yield response;
    }
  }
}

class HangingModel implements Model {
  async *stream(
    _messages: Message[],
    options?: StreamOptions,
  ): AsyncGenerator<Response> {
    yield {type: 'text_delta', text: 'partial'};

    // 取消可能发生在监听器注册之前，先补一次已中止检查
    if (options?.signal?.aborted) {
      throw new Error('aborted');
    }

    await new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => {
          reject(new Error('aborted'));
        },
        {once: true},
      );
    });
  }
}
