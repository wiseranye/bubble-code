import { expect, test } from 'vitest';
import { Agent } from '../../src/agent/agent.ts';
import {
  AgentSession,
  type AgentSessionEvent,
  type TextChatMessage,
  type ToolChatMessage,
} from '../../src/agent/agent-session.ts';
import {
  type AgentMessage,
  type AssistantMessage,
  AssistantMessageEventStream,
  MockModel,
  type Model,
  type StreamOptions,
  type Text,
  type Thinking,
  type ToolCall,
} from '../../src/llm/types.ts';
import { ToolRegistry } from '../../src/tools/types.ts';

// 等条件成立，最多让出若干轮事件循环
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) {
      return;
    }

    await new Promise<void>(resolve => {
      setImmediate(resolve);
    });
  }

  throw new Error('condition not met');
}

function record(session: AgentSession): AgentSessionEvent[] {
  const events: AgentSessionEvent[] = [];
  session.subscribe(event => events.push(event));
  return events;
}

function streamingFlags(events: AgentSessionEvent[]): boolean[] {
  return events.flatMap(event =>
    event.type === 'streaming_changed' ? [event.isStreaming] : [],
  );
}

function assistantMessages(session: AgentSession): TextChatMessage[] {
  return session.messages.filter(
    (message): message is TextChatMessage => message.role === 'assistant',
  );
}

test('streams assistant text and seals both messages', async () => {
  const agent = new Agent({
    model: new MockModel(0),
    tools: new ToolRegistry(),
  });
  const session = new AgentSession(agent);
  const events = record(session);

  expect(session.messages.length).toBe(1);
  expect(session.messages[0]?.role).toBe('system');

  session.prompt('你好');
  expect(session.isStreaming).toBe(true);

  await until(() => !session.isStreaming);

  // 用户消息：added 后立刻 sealed
  expect(
    events.some(
      event => event.type === 'message_added' && event.message.role === 'user',
    ),
  ).toBe(true);
  expect(
    events.some(
      event => event.type === 'message_sealed' && event.message.role === 'user',
    ),
  ).toBe(true);

  // 助手消息：added（首个增量）→ updated（后续增量）→ sealed（收尾）
  const assistant = assistantMessages(session)[0];
  expect(assistant).toBeTruthy();
  expect((assistant?.content ?? '').includes('mock reply')).toBe(true);
  expect(
    events.some(
      event =>
        event.type === 'message_updated' && event.message.role === 'assistant',
    ),
  ).toBe(true);
  expect(
    events.some(
      event =>
        event.type === 'message_sealed' && event.message.role === 'assistant',
    ),
  ).toBe(true);

  // Streaming 开关严格成对
  expect(streamingFlags(events)).toEqual([true, false]);
});

test('running a tool creates a tool message that is updated and sealed', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: 'echo',
    inputSchema: {},
    async execute(input: Record<string, unknown>) {
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature 要求索引签名用方括号
      return { success: true, output: `ok: ${String(input['value'])}` };
    },
  });

  const model = new ScriptedModel([
    {
      text: '让我看看。',
      toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hi' } }],
    },
    { text: '完成了。' },
  ]);
  const agent = new Agent({ model, tools: registry });
  const session = new AgentSession(agent);
  const events = record(session);

  session.prompt('跑一下');
  await until(() => !session.isStreaming);

  const tools = session.messages.filter(
    (message): message is ToolChatMessage => message.role === 'tool',
  );
  expect(tools.length).toBe(1);
  expect(tools[0]?.status).toBe('done');
  expect(tools[0]?.success).toBe(true);
  expect(tools[0]?.output).toBe('ok: hi');
  expect(tools[0]?.input).toBe('{"value":"hi"}');

  // 工具开始前，前一段文本已冻结；工具结果回来后再冻结工具消息
  expect(
    events.some(
      event =>
        event.type === 'message_sealed' &&
        event.message.role === 'assistant' &&
        event.message.content === '让我看看。',
    ),
  ).toBe(true);
  expect(
    events.some(
      event => event.type === 'message_sealed' && event.message.role === 'tool',
    ),
  ).toBe(true);

  // 工具调用之后的文本是新的一条助手消息
  const assistants = assistantMessages(session);
  expect(assistants.length).toBe(2);
  expect(assistants[1]?.content).toBe('完成了。');

  expect(streamingFlags(events)).toEqual([true, false]);
});

test('thinking deltas accumulate into a separate dim message', async () => {
  const model = new ScriptedModel([{ thinking: '先想想。', text: '答案。' }]);
  const agent = new Agent({ model, tools: new ToolRegistry() });
  const session = new AgentSession(agent);
  const events = record(session);

  session.prompt('想想');
  await until(() => !session.isStreaming);

  const thinking = session.messages.find(
    (message): message is TextChatMessage => message.role === 'thinking',
  );
  expect(thinking?.content).toBe('先想想。');
  // 正文和思考是两条独立消息，思考在正文之前
  const assistant = assistantMessages(session)[0];
  expect(assistant?.content).toBe('答案。');
  expect(
    session.messages.indexOf(thinking!) < session.messages.indexOf(assistant!),
  ).toBe(true);
  expect(
    events.some(
      event =>
        event.type === 'message_sealed' && event.message.role === 'thinking',
    ),
  ).toBe(true);
});

test('cancel seals the partial assistant text and appends an interrupt notice', async () => {
  const agent = new Agent({
    model: new HangingModel(),
    tools: new ToolRegistry(),
  });
  const session = new AgentSession(agent);
  const events = record(session);

  session.prompt('开始');
  await until(() =>
    session.messages.some(message => message.role === 'assistant'),
  );

  session.cancel();
  await until(() => !session.isStreaming);

  // 残缺的 assistant 文本原样封合，不掺入任何提示文字
  const assistant = assistantMessages(session)[0];
  expect(assistant?.content).toBe('partial');
  expect(
    events.some(
      event =>
        event.type === 'message_sealed' && event.message.role === 'assistant',
    ),
  ).toBe(true);

  // 中断提示是独立的一条 system 消息，跟在残缺文本之后
  const notice = session.messages.find(
    (message): message is TextChatMessage =>
      message.role === 'system' && message.content.includes('[已中断]'),
  );
  expect(notice?.content).toBe('[已中断] 用户按 ESC 取消了本次生成');
  expect(
    session.messages.indexOf(notice!) > session.messages.indexOf(assistant!),
  ).toBe(true);
  expect(
    events.some(
      event =>
        event.type === 'message_added' && event.message.id === notice?.id,
    ),
  ).toBe(true);
  expect(
    events.some(
      event =>
        event.type === 'message_sealed' && event.message.id === notice?.id,
    ),
  ).toBe(true);

  expect(streamingFlags(events)).toEqual([true, false]);
});

test('provider error surfaces as an assistant message', async () => {
  const agent = new Agent({
    model: new FailingModel(),
    tools: new ToolRegistry(),
  });
  const session = new AgentSession(agent);
  const events = record(session);

  session.prompt('会失败');
  await until(() => !session.isStreaming);

  const assistant = assistantMessages(session)[0];
  expect((assistant?.content ?? '').includes('[出错] boom')).toBe(true);
  expect(streamingFlags(events)).toEqual([true, false]);
});

test('send is ignored while generating and for empty input', async () => {
  const agent = new Agent({
    model: new HangingModel(),
    tools: new ToolRegistry(),
  });
  const session = new AgentSession(agent);

  session.prompt('   ');
  expect(session.isStreaming).toBe(false);

  session.prompt('第一次');
  expect(session.isStreaming).toBe(true);
  session.prompt('第二次');
  expect(
    session.messages.filter(message => message.role === 'user').length,
  ).toBe(1);

  session.cancel();
  await until(() => !session.isStreaming);
});

type ScriptTurn = {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
};

// 按剧本逐轮回放 StreamChunkEvent；每次 stream 调用消费一轮
class ScriptedModel implements Model {
  private index = 0;
  private readonly script: ScriptTurn[];

  constructor(script: ScriptTurn[]) {
    this.script = script;
  }

  stream(
    _messages: AgentMessage[],
    _options?: StreamOptions,
  ): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();
    const turn = this.script[this.index++] ?? { text: '' };
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    stream.push({ type: 'start', partial: output });
    let index = 0;

    if (turn.thinking !== undefined) {
      const block: Thinking = { type: 'thinking', thinking: turn.thinking };
      const blockIndex = index++;
      output.content.push(block);
      stream.push({
        type: 'thinking_start',
        index: blockIndex,
        partial: output,
      });
      stream.push({
        type: 'thinking_delta',
        index: blockIndex,
        delta: turn.thinking,
        partial: output,
      });
      stream.push({
        type: 'thinking_end',
        index: blockIndex,
        thinking: block,
        partial: output,
      });
    }

    if (turn.text !== undefined) {
      const block: Text = { type: 'text', text: turn.text };
      const blockIndex = index++;
      output.content.push(block);
      stream.push({ type: 'text_start', index: blockIndex, partial: output });
      // 拆成两个 delta，覆盖 message_updated 路径
      const half = Math.ceil(turn.text.length / 2);
      stream.push({
        type: 'text_delta',
        index: blockIndex,
        delta: turn.text.slice(0, half),
        partial: output,
      });
      stream.push({
        type: 'text_delta',
        index: blockIndex,
        delta: turn.text.slice(half),
        partial: output,
      });
      stream.push({
        type: 'text_end',
        index: blockIndex,
        text: block,
        partial: output,
      });
    }

    for (const call of turn.toolCalls ?? []) {
      const block: ToolCall = {
        type: 'tool_call',
        id: call.id,
        name: call.name,
        input: call.input,
      };
      const blockIndex = index++;
      output.content.push(block);
      stream.push({
        type: 'tool_call_start',
        index: blockIndex,
        toolCall: block,
        partial: output,
      });
      stream.push({
        type: 'tool_call_end',
        index: blockIndex,
        toolCall: block,
        partial: output,
      });
    }

    const hasToolCalls = (turn.toolCalls ?? []).length > 0;
    output.stopReason = hasToolCalls ? 'tool_use' : 'stop';
    stream.push({
      type: 'done',
      reason: hasToolCalls ? 'tool_use' : 'stop',
      message: output,
    });
    stream.end();
    return stream;
  }
}

// 流出一小段文本后挂住，直到外部 abort 才以 error(aborted) 收尾
class HangingModel implements Model {
  stream(
    _messages: AgentMessage[],
    options?: StreamOptions,
  ): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();
    const output: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    stream.push({ type: 'start', partial: output });
    stream.push({ type: 'text_start', index: 0, partial: output });
    stream.push({
      type: 'text_delta',
      index: 0,
      delta: 'partial',
      partial: output,
    });

    const abort = () => {
      output.stopReason = 'aborted';
      stream.push({
        type: 'error',
        reason: 'aborted',
        error: new Error('Request was aborted'),
        message: output,
      });
      stream.end();
    };

    // 取消可能发生在监听器注册之前，先补一次已中止检查
    if (options?.signal?.aborted) {
      abort();
    } else {
      options?.signal?.addEventListener('abort', abort, { once: true });
    }

    return stream;
  }
}

// 建连即失败：只发一个 error 事件
class FailingModel implements Model {
  stream(): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'boom',
      timestamp: Date.now(),
    };
    stream.push({
      type: 'error',
      reason: 'error',
      error: new Error('boom'),
      message: output,
    });
    stream.end();
    return stream;
  }
}
