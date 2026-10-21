import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { Agent } from '../../src/agent/agent.ts';
import {
  AgentSession,
  type AgentSessionEvent,
  type TextChatMessage,
  type ToolChatMessage,
} from '../../src/agent/agent-session.ts';
import type { SessionEntry } from '../../src/agent/session-manager.ts';
import type { AgentEvent } from '../../src/agent/types.ts';
import {
  type AgentMessage,
  type AssistantMessage,
  AssistantMessageEventStream,
  type Message,
  type ModelApi,
  type StreamOptions,
  type Text,
  type Thinking,
  type ToolCall,
} from '../../src/llm/types.ts';
import { defineTool } from '../../src/tools/schema.ts';
import { ToolRegistry } from '../../src/tools/types.ts';

// AgentSession 会把会话写到 BUBBLE_HOME（缺省 ~/.bubble）。
// 不隔离的话，每个构造 AgentSession 的用例都会往真实会话目录写垃圾文件
let bubbleHome: string;

// 本用例创建的全部会话：写入是异步入队的，afterEach 必须先把它们排空再删目录
const openSessions: AgentSession[] = [];

beforeEach(() => {
  bubbleHome = mkdtempSync(join(tmpdir(), 'bubble-home-'));
  vi.stubEnv('BUBBLE_HOME', bubbleHome);
});

afterEach(async () => {
  // 会话写入先进队列，文件 open 又是异步的：不等落盘就删临时目录，
  // 排队中的 open() 会拿到 ENOENT。那是无监听的流 error，不是 promise 拒绝，
  // 队列上的 catch 接不住，直接变成未捕获异常
  await Promise.all(openSessions.map(session => session.dispose()));
  openSessions.length = 0;
  vi.unstubAllEnvs();
  rmSync(bubbleHome, { recursive: true, force: true });
});

// 所有 AgentSession 都从这里创建，afterEach 才知道要排空谁；重复 dispose 是幂等的
function openSession(agent: Agent, sessionFile?: string): AgentSession {
  const session = new AgentSession(agent, sessionFile);
  openSessions.push(session);
  return session;
}

// A mock implementation used until a real model backend is wired up. It
// streams a canned reply token-by-token so the UI behaves like a real
// streaming agent.
class MockModel implements ModelApi {
  private readonly delay: number;

  constructor(delay: number = 20) {
    this.delay = delay;
  }

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
    modelApi: new MockModel(0),
    tools: new ToolRegistry(),
  });
  const session = openSession(agent);
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
  registry.register(
    defineTool({
      name: 'echo',
      description: 'echo',
      inputSchema: z.object({ value: z.string() }),
      async execute(input: Record<string, unknown>) {
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature 要求索引签名用方括号
        return { success: true, output: `ok: ${String(input['value'])}` };
      },
    }),
  );

  const model = new ScriptedModel([
    {
      text: '让我看看。',
      toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hi' } }],
    },
    { text: '完成了。' },
  ]);
  const agent = new Agent({ modelApi: model, tools: registry });
  const session = openSession(agent);
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

test('a failing tool keeps error and output separate', async () => {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: 'boom',
      description: 'boom',
      inputSchema: z.object({}),
      async execute() {
        return { success: false, output: '部分输出', error: '命令失败' };
      },
    }),
  );

  const model = new ScriptedModel([
    { toolCalls: [{ id: 'call-1', name: 'boom', input: {} }] },
    { text: '知道了。' },
  ]);
  const agent = new Agent({ modelApi: model, tools: registry });
  const agentEvents: AgentEvent[] = [];
  agent.subscribe(event => {
    agentEvents.push(event);
  });
  const session = openSession(agent);

  session.prompt('跑一下');
  await until(() => !session.isStreaming);

  const tool = session.messages.find(
    (message): message is ToolChatMessage => message.role === 'tool',
  );
  expect(tool?.status).toBe('done');
  expect(tool?.success).toBe(false);
  // error 不并进 output，UI 和持久化各自拿到原始字段
  expect(tool?.output).toBe('部分输出');
  expect(tool?.error).toBe('命令失败');

  const results = agentEvents.filter(
    (event): event is Extract<AgentEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result',
  );
  expect(results.length).toBe(1);
  expect(results[0]?.result.output).toBe('部分输出');
  expect(results[0]?.result.error).toBe('命令失败');
  expect(results[0]?.success).toBe(false);

  // 回喂给模型的协议消息同样保持两个字段分离（拼文本在 llm 适配层做）
  const contextResults = agent.state.messages.flatMap(message =>
    message.role === 'tool_result' ? [message] : [],
  );
  expect(contextResults[0]?.output).toBe('部分输出');
  expect(contextResults[0]?.error).toBe('命令失败');
});

test('tool result metadata is stored, persisted and reloaded', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-session-'));
  vi.stubEnv('BUBBLE_HOME', home);
  try {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'edit',
        description: 'edit',
        inputSchema: z.object({}),
        async execute() {
          return {
            success: true,
            output: '已修改',
            metadata: { diff: '+1 -0' },
          };
        },
      }),
    );
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'call-1', name: 'edit', input: {} }] },
      { text: '完成。' },
    ]);
    const session = openSession(
      new Agent({ modelApi: model, tools: registry }),
    );

    session.prompt('改一下');
    await until(() => !session.isStreaming);

    const tool = session.messages.find(
      (message): message is ToolChatMessage => message.role === 'tool',
    );
    expect(tool?.metadata).toEqual({ diff: '+1 -0' });

    // 等写入落盘再读文件
    await session.dispose();
    const [projectDir] = readdirSync(join(home, 'sessions'));
    const [fileName] = readdirSync(join(home, 'sessions', projectDir!));
    const filePath = join(home, 'sessions', projectDir!, fileName!);
    const entries = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as SessionEntry);
    const stored = entries.flatMap(entry =>
      entry.type === 'message' && entry.message.role === 'tool_result'
        ? [entry.message]
        : [],
    );
    expect(stored[0]?.metadata).toEqual({ diff: '+1 -0' });

    // 重开一个会话读同一个文件：metadata 不丢
    const resumedAgent = new Agent({
      modelApi: new MockModel(0),
      tools: new ToolRegistry(),
    });
    const resumedSession = openSession(resumedAgent, filePath);
    const resumed = resumedAgent.state.messages.flatMap(message =>
      message.role === 'tool_result' ? [message] : [],
    );
    expect(resumed[0]?.metadata).toEqual({ diff: '+1 -0' });

    // 重建的 ToolChatMessage 也要带上 output 与 metadata：UI 靠 metadata 画 diff
    const resumedTool = resumedSession.messages.find(
      (message): message is ToolChatMessage => message.role === 'tool',
    );
    expect(resumedTool?.output).toBe('已修改');
    expect(resumedTool?.metadata).toEqual({ diff: '+1 -0' });
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a session file without error and metadata fields still loads', () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-session-'));
  try {
    // 旧格式：tool_result 只有 output，没有 error / metadata 字段
    const filePath = join(home, 'session-old.jsonl');
    const entries: SessionEntry[] = [
      {
        type: 'metadata',
        id: 'old',
        cwd: process.cwd(),
        version: 1,
        timestamp: 1,
      },
      {
        type: 'message',
        id: 'e1',
        timestamp: 2,
        message: { role: 'user', content: '读一下 a.ts', timestamp: 2 },
      },
      {
        type: 'message',
        id: 'e2',
        timestamp: 3,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'call-1',
              name: 'read',
              input: { filePath: 'a.ts' },
            },
          ],
          stopReason: 'tool_use',
          timestamp: 3,
        },
      },
      {
        type: 'message',
        id: 'e3',
        timestamp: 4,
        message: {
          role: 'tool_result',
          toolName: 'read',
          toolCallId: 'call-1',
          output: '文件内容',
          timestamp: 4,
        },
      },
    ];
    writeFileSync(
      filePath,
      `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    );

    const agent = new Agent({
      modelApi: new MockModel(0),
      tools: new ToolRegistry(),
    });
    const session = openSession(agent, filePath);

    expect(agent.state.messages.map(message => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool_result',
    ]);
    const tool = session.messages.find(
      (message): message is ToolChatMessage => message.role === 'tool',
    );
    expect(tool?.output).toBe('文件内容');
    expect(tool?.error).toBeUndefined();
    expect(tool?.metadata).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('thinking deltas accumulate into a separate dim message', async () => {
  const model = new ScriptedModel([{ thinking: '先想想。', text: '答案。' }]);
  const agent = new Agent({ modelApi: model, tools: new ToolRegistry() });
  const session = openSession(agent);
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
    modelApi: new HangingModel(),
    tools: new ToolRegistry(),
  });
  const session = openSession(agent);
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
    modelApi: new FailingModel(),
    tools: new ToolRegistry(),
  });
  const session = openSession(agent);
  const events = record(session);

  session.prompt('会失败');
  await until(() => !session.isStreaming);

  const assistant = assistantMessages(session)[0];
  expect((assistant?.content ?? '').includes('[出错] boom')).toBe(true);
  expect(streamingFlags(events)).toEqual([true, false]);
});

test('send is ignored while generating and for empty input', async () => {
  const agent = new Agent({
    modelApi: new HangingModel(),
    tools: new ToolRegistry(),
  });
  const session = openSession(agent);

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

test('session file writes assistant message before its tool results', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-session-'));
  vi.stubEnv('BUBBLE_HOME', home);
  try {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'echo',
        description: 'echo',
        inputSchema: z.object({ value: z.string() }),
        async execute(input: Record<string, unknown>) {
          // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature 要求索引签名用方括号
          return { success: true, output: `ok: ${String(input['value'])}` };
        },
      }),
    );
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hi' } }] },
      { text: '完成了。' },
    ]);
    const session = openSession(
      new Agent({ modelApi: model, tools: registry }),
    );
    session.prompt('跑一下');
    await until(() => !session.isStreaming);
    // 等写入落盘再读文件
    await session.dispose();

    const [projectDir] = readdirSync(join(home, 'sessions'));
    const [fileName] = readdirSync(join(home, 'sessions', projectDir!));
    const entries = readFileSync(
      join(home, 'sessions', projectDir!, fileName!),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as SessionEntry);
    const roles = entries.flatMap(entry =>
      entry.type === 'message' ? [entry.message.role] : [],
    );

    // API 要求 tool 消息紧跟在带 tool_calls 的 assistant 之后
    const assistantIndex = roles.indexOf('assistant');
    const toolResultIndex = roles.indexOf('tool_result');
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(toolResultIndex).toBeGreaterThan(assistantIndex);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

test('resuming a session with tool_result before its assistant message repairs the order', () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-session-'));
  try {
    // 复刻旧持久化 bug 写出的文件：tool_result 排在发起它的 assistant 之前
    const filePath = join(home, 'session-broken.jsonl');
    const entries: SessionEntry[] = [
      {
        type: 'metadata',
        id: 'broken',
        cwd: process.cwd(),
        version: 1,
        timestamp: 1,
      },
      {
        type: 'message',
        id: 'e1',
        timestamp: 2,
        message: { role: 'user', content: '读一下 a.ts', timestamp: 2 },
      },
      {
        type: 'message',
        id: 'e3',
        timestamp: 3,
        message: {
          role: 'tool_result',
          toolName: 'read',
          toolCallId: 'call-1',
          output: '文件内容',
          timestamp: 3,
        },
      },
      {
        type: 'message',
        id: 'e4',
        timestamp: 4,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'call-1',
              name: 'read',
              input: { filePath: 'a.ts' },
            },
          ],
          stopReason: 'tool_use',
          timestamp: 4,
        },
      },
    ];
    writeFileSync(
      filePath,
      `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    );

    const agent = new Agent({
      modelApi: new MockModel(0),
      tools: new ToolRegistry(),
    });
    const session = openSession(agent, filePath);

    // 恢复后发给模型的消息：assistant 必须在它的 tool_result 之前
    const roles = agent.state.messages.map(message => message.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool_result']);

    // 工具结果也要能贴回 UI 上的工具消息
    const tool = session.messages.find(message => message.role === 'tool');
    expect(tool?.output).toBe('文件内容');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resume drops tool calls that have no matching tool result', () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-session-'));
  try {
    // 中断时可能只留下带 tool_calls 的 assistant，没有对应 tool_result；
    // 原样发给 API 会 400，恢复时剥掉未完成的调用
    const filePath = join(home, 'session-orphan.jsonl');
    const entries: SessionEntry[] = [
      {
        type: 'metadata',
        id: 'orphan',
        cwd: process.cwd(),
        version: 1,
        timestamp: 1,
      },
      {
        type: 'message',
        id: 'e1',
        timestamp: 2,
        message: { role: 'user', content: '干活', timestamp: 2 },
      },
      {
        type: 'message',
        id: 'e2',
        timestamp: 3,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '让我看看。' },
            {
              type: 'tool_call',
              id: 'call-1',
              name: 'read',
              input: { filePath: 'a.ts' },
            },
          ],
          stopReason: 'tool_use',
          timestamp: 3,
        },
      },
    ];
    writeFileSync(
      filePath,
      `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    );

    const agent = new Agent({
      modelApi: new MockModel(0),
      tools: new ToolRegistry(),
    });
    openSession(agent, filePath);

    const assistant = agent.state.messages.find(
      message => message.role === 'assistant',
    );
    expect(assistant?.content.every(block => block.type !== 'tool_call')).toBe(
      true,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
class ScriptedModel implements ModelApi {
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
class HangingModel implements ModelApi {
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
class FailingModel implements ModelApi {
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

function systemNotices(session: AgentSession): string[] {
  return session.messages.flatMap(message =>
    message.role === 'system' ? [message.content] : [],
  );
}

test('setModel switches the model used by subsequent prompts', async () => {
  const agent = new Agent({
    modelApi: new ScriptedModel([{ text: '旧模型的回复' }]),
    tools: new ToolRegistry(),
  });
  const session = openSession(agent);

  session.prompt('第一句');
  await until(() => !session.isStreaming);
  expect(assistantMessages(session).at(-1)?.content).toContain('旧模型的回复');

  session.setModel(new ScriptedModel([{ text: '新模型的回复' }]), 256_000);
  session.prompt('第二句');
  await until(() => !session.isStreaming);

  expect(assistantMessages(session).at(-1)?.content).toContain('新模型的回复');
});

test('setModel strips thinking replay data from history but keeps the text', () => {
  const agent = new Agent({
    modelApi: new MockModel(0),
    tools: new ToolRegistry(),
  });
  const session = openSession(agent);
  const message: AssistantMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '想了一下', thinkingReplayData: 'sig-123' },
      { type: 'text', text: '回复' },
    ],
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  agent.state.messages.push(message);

  session.setModel(new MockModel(0), 256_000);

  const thinking = message.content[0];
  expect(thinking?.type === 'thinking' && thinking.thinkingReplayData).toBe(
    undefined,
  );
  expect(thinking?.type === 'thinking' && thinking.thinking).toBe('想了一下');
});

test('setModel contextWindow applies to auto compaction on the next prompt', async () => {
  // 默认配置的大窗口下第一轮不压缩；setModel 换成小窗口后第二轮触发自动压缩
  const oldModel = new ScriptedModel([{ text: 'A'.repeat(4000) }]);
  const agent = new Agent({ modelApi: oldModel, tools: new ToolRegistry() });
  const session = openSession(agent);

  session.prompt('第一句');
  await until(() => !session.isStreaming);
  expect(
    systemNotices(session).some(content => content.includes('上下文已压缩')),
  ).toBe(false);

  // 摘要调用消耗新模型的第一轮剧本，正常回复消耗第二轮
  session.setModel(
    new ScriptedModel([{ text: '这是摘要。' }, { text: '完成。' }]),
    1000,
  );
  session.prompt('第二句');
  await until(() => !session.isStreaming);

  expect(
    systemNotices(session).some(content => content.includes('上下文已压缩')),
  ).toBe(true);
  expect(assistantMessages(session).at(-1)?.content).toContain('完成。');
});
