import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { Agent } from '../../src/agent/agent.ts';
import { AgentSession } from '../../src/agent/agent-session.ts';
import type { CompactConfig } from '../../src/agent/compaction.ts';
import { projectSendView } from '../../src/agent/send-view.ts';
import type { SessionEntry } from '../../src/agent/session-manager.ts';
import { SystemPromptAssembler } from '../../src/agent/system-prompt.ts';
import {
  type AgentMessage,
  type AssistantMessage,
  AssistantMessageEventStream,
  type ModelApi,
  type StreamOptions,
  type Text,
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
  await Promise.all(openSessions.map(session => session.dispose()));
  openSessions.length = 0;
  vi.unstubAllEnvs();
  rmSync(bubbleHome, { recursive: true, force: true });
});

function openSession(
  agent: Agent,
  sessionFile?: string,
  compactConfig?: CompactConfig,
): AgentSession {
  const session = new AgentSession(agent, sessionFile, compactConfig);
  openSessions.push(session);
  return session;
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

type ScriptTurn = {
  text?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
};

// 按剧本逐轮回放，并记录每次 stream 实际收到的消息列表（用来验证发送视图）
class CapturingModel implements ModelApi {
  readonly requests: AgentMessage[][] = [];
  private index = 0;
  private readonly script: ScriptTurn[];

  constructor(script: ScriptTurn[]) {
    this.script = script;
  }

  stream(
    messages: AgentMessage[],
    _options?: StreamOptions,
  ): AssistantMessageEventStream {
    this.requests.push([...messages]);
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

    if (turn.text !== undefined) {
      const block: Text = { type: 'text', text: turn.text };
      output.content.push(block);
      stream.push({ type: 'text_start', index, partial: output });
      stream.push({
        type: 'text_delta',
        index,
        delta: turn.text,
        partial: output,
      });
      stream.push({ type: 'text_end', index, text: block, partial: output });
      index++;
    }

    for (const call of turn.toolCalls ?? []) {
      const block: ToolCall = {
        type: 'tool_call',
        id: call.id,
        name: call.name,
        input: call.input,
      };
      output.content.push(block);
      stream.push({
        type: 'tool_call_end',
        index,
        toolCall: block,
        partial: output,
      });
      index++;
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

function echoRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: 'echo',
      description: 'echo',
      inputSchema: z.object({}),
      async execute() {
        return { success: true, output: 'ok' };
      },
    }),
  );
  return registry;
}

function defineExtraTool(name: string) {
  return defineTool({
    name,
    description: name,
    inputSchema: z.object({}),
    async execute() {
      return { success: true, output: 'ok' };
    },
  });
}

// 读取 BUBBLE_HOME 里唯一会话文件的条目
function readSessionEntries(): SessionEntry[] {
  const [projectDir] = readdirSync(join(bubbleHome, 'sessions'));
  const [fileName] = readdirSync(join(bubbleHome, 'sessions', projectDir!));
  return readFileSync(
    join(bubbleHome, 'sessions', projectDir!, fileName!),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SessionEntry);
}

function systemMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter(message => message.role === 'system');
}

test('projectSendView keeps only the last system message and moves it to the front', () => {
  const sys1: AgentMessage = { role: 'system', content: 'old' };
  const sys2: AgentMessage = { role: 'system', content: 'new' };
  const user: AgentMessage = { role: 'user', content: 'u', timestamp: 1 };
  const assistant: AgentMessage = {
    role: 'assistant',
    content: [],
    stopReason: 'stop',
    timestamp: 2,
  };

  // 无系统消息：原样
  expect(projectSendView([user, assistant])).toEqual([user, assistant]);
  // 单条系统消息且已在开头：原序
  expect(projectSendView([sys1, user, assistant])).toEqual([
    sys1,
    user,
    assistant,
  ]);
  // 多条：只留最后一条并移到开头，其余消息保持原序
  expect(projectSendView([sys1, user, sys2, assistant])).toEqual([
    sys2,
    user,
    assistant,
  ]);
});

test('assembler rebuilds per-refresh sections and caches construction sections', () => {
  const registry = echoRegistry();
  const assembler = new SystemPromptAssembler({
    tools: registry,
    cwd: process.cwd(),
  });

  const first = assembler.build();
  expect(first.content).toContain('你是 Bubble Code');
  expect(first.content).toContain('- echo: echo');
  expect(Object.keys(first.sections)).toEqual([
    'identity',
    'tools',
    'project_context',
    'cwd',
  ]);

  // 没有变化时指纹稳定
  expect(assembler.build().sections).toEqual(first.sections);

  // 注册新工具：tools 节（per-refresh）指纹变化，construction 节不变
  registry.register(defineExtraTool('extra'));
  const second = assembler.build();
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature 要求索引签名用方括号
  expect(second.sections['tools']).not.toBe(first.sections['tools']);
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature 要求索引签名用方括号
  expect(second.sections['identity']).toBe(first.sections['identity']);
  expect(second.content).toContain('- extra: extra');
});

test('assembler omits the project_context section when no AGENTS.md exists', () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'bubble-empty-'));
  try {
    const assembler = new SystemPromptAssembler({
      tools: echoRegistry(),
      cwd: emptyDir,
    });
    const built = assembler.build();
    expect(Object.keys(built.sections)).toEqual(['identity', 'tools', 'cwd']);
    expect(built.content).not.toContain('project_context');
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('first prompt builds the system message and persists it before the user message', async () => {
  const model = new CapturingModel([{ text: '回复' }]);
  const agent = new Agent({ modelApi: model, tools: echoRegistry() });
  const session = openSession(agent);

  session.prompt('你好');
  await until(() => !session.isStreaming);

  // 内存：系统消息在首位，带 sections 指纹
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'system',
    'user',
    'assistant',
  ]);
  const system = agent.state.messages[0];
  expect(system?.role === 'system' && system.sections !== undefined).toBe(true);
  expect(
    system?.role === 'system' && system.content.includes('- echo: echo'),
  ).toBe(true);

  // 模型实际收到的第一条就是系统消息
  expect(model.requests[0]?.[0]?.role).toBe('system');

  // 落盘：系统消息条目排在用户消息之前
  await session.dispose();
  const entries = readSessionEntries();
  const roles = entries.flatMap(entry =>
    entry.type === 'message' ? [entry.message.role] : [],
  );
  expect(roles).toEqual(['system', 'user', 'assistant']);
  const systemEntry = entries.find(
    entry => entry.type === 'message' && entry.message.role === 'system',
  );
  expect(
    systemEntry?.type === 'message' &&
      systemEntry.message.role === 'system' &&
      systemEntry.message.sections !== undefined,
  ).toBe(true);
});

test('no second system message when nothing changed between runs', async () => {
  const model = new CapturingModel([{ text: '一' }, { text: '二' }]);
  const agent = new Agent({ modelApi: model, tools: echoRegistry() });
  const session = openSession(agent);

  session.prompt('第一句');
  await until(() => !session.isStreaming);
  session.prompt('第二句');
  await until(() => !session.isStreaming);

  const systems = systemMessages(agent.state.messages);
  expect(systems.length).toBe(1);
  // 第二次请求收到的仍是这同一条系统消息
  expect(model.requests.length).toBe(2);
  expect(model.requests[1]?.[0]).toBe(systems[0]);
});

test('registering a tool between runs appends a new system message; only the latest is sent', async () => {
  const model = new CapturingModel([{ text: '一' }, { text: '二' }]);
  const registry = echoRegistry();
  const agent = new Agent({ modelApi: model, tools: registry });
  const session = openSession(agent);

  session.prompt('第一句');
  await until(() => !session.isStreaming);

  registry.register(defineExtraTool('extra'));
  session.prompt('第二句');
  await until(() => !session.isStreaming);

  // 存储：两条系统消息按生产顺序排列，新的排在第二句用户消息之前
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'system',
    'user',
    'assistant',
    'system',
    'user',
    'assistant',
  ]);
  const latest = agent.state.messages[3];
  expect(
    latest?.role === 'system' && latest.content.includes('- extra: extra'),
  ).toBe(true);

  // 发送：第二次请求只有一条系统消息，在开头且是最新的
  const second = model.requests[1];
  expect(systemMessages(second ?? []).length).toBe(1);
  expect(second?.[0]).toBe(latest);

  // 落盘：两条系统消息条目都在
  await session.dispose();
  const entries = readSessionEntries();
  const stored = entries.flatMap(entry =>
    entry.type === 'message' && entry.message.role === 'system'
      ? [entry.message]
      : [],
  );
  expect(stored.length).toBe(2);
});

test('a mid-run change is picked up before the next request of the same run', async () => {
  const registry = echoRegistry();
  const model = new CapturingModel([
    { text: '先看看', toolCalls: [{ id: 'call-1', name: 'echo', input: {} }] },
    { text: '完成' },
  ]);
  const agent = new Agent({ modelApi: model, tools: registry });
  // 在第二个 turn 前注册新工具：模拟扩展在 run 中途接入。
  // 先于会话的内置钩子注册，保证刷新能看到这次变化
  let injected = false;
  agent.registerHook({
    prepareTurn: context => {
      if (
        !injected &&
        context.messages.some(message => message.role === 'tool_result')
      ) {
        injected = true;
        registry.register(defineExtraTool('midrun'));
      }
    },
  });
  const session = openSession(agent);

  session.prompt('跑一下');
  await until(() => !session.isStreaming);

  // 存储：第二条系统消息按生产顺序排在 tool_result 之后
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'system',
    'user',
    'assistant',
    'tool_result',
    'system',
    'assistant',
  ]);

  // 第一次请求用的是构造时的系统消息；第二次请求只有刷新后的那一条
  expect(model.requests.length).toBe(2);
  const firstSystem = model.requests[0]?.[0];
  expect(
    firstSystem?.role === 'system' && !firstSystem.content.includes('midrun'),
  ).toBe(true);
  const second = model.requests[1];
  expect(systemMessages(second ?? []).length).toBe(1);
  expect(
    second?.[0]?.role === 'system' &&
      second[0].content.includes('- midrun: midrun'),
  ).toBe(true);
});

test('resume of an old-format session appends a fresh system message on the first prompt', async () => {
  // 老格式会话文件：没有系统消息条目
  const filePath = join(bubbleHome, 'session-old.jsonl');
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
        content: [{ type: 'text', text: '读完了' }],
        stopReason: 'stop',
        timestamp: 3,
      },
    },
  ];
  writeFileSync(
    filePath,
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
  );

  const model = new CapturingModel([{ text: '继续' }]);
  const agent = new Agent({ modelApi: model, tools: echoRegistry() });
  const session = openSession(agent, filePath);

  // 恢复后历史里没有系统消息
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'user',
    'assistant',
  ]);

  session.prompt('接着干');
  await until(() => !session.isStreaming);

  // 无基线 → 追加一条新的系统消息；存储按生产顺序排在老消息之后
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'user',
    'assistant',
    'system',
    'user',
    'assistant',
  ]);
  // 发送视图把它移到开头
  const system = agent.state.messages[2];
  expect(model.requests[0]?.[0]).toBe(system);

  // 落盘：系统条目追加在老条目之后
  await session.dispose();
  const written = readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SessionEntry);
  const roles = written.flatMap(entry =>
    entry.type === 'message' ? [entry.message.role] : [],
  );
  expect(roles).toEqual(['user', 'assistant', 'system', 'user', 'assistant']);
});

test('resume of a new-format session reuses the persisted sections as the diff baseline', async () => {
  // 第一个会话：产生系统消息并落盘
  const firstAgent = new Agent({
    modelApi: new CapturingModel([{ text: '一' }]),
    tools: echoRegistry(),
  });
  const firstSession = openSession(firstAgent);
  firstSession.prompt('你好');
  await until(() => !firstSession.isStreaming);
  await firstSession.dispose();

  const [projectDir] = readdirSync(join(bubbleHome, 'sessions'));
  const [fileName] = readdirSync(join(bubbleHome, 'sessions', projectDir!));
  const filePath = join(bubbleHome, 'sessions', projectDir!, fileName!);

  // 恢复：内容没有漂移，首个 run 不再追加系统消息
  const secondAgent = new Agent({
    modelApi: new CapturingModel([{ text: '二' }]),
    tools: echoRegistry(),
  });
  const secondSession = openSession(secondAgent, filePath);
  secondSession.prompt('继续');
  await until(() => !secondSession.isStreaming);

  expect(systemMessages(secondAgent.state.messages).length).toBe(1);

  await secondSession.dispose();
  const written = readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SessionEntry);
  const stored = written.flatMap(entry =>
    entry.type === 'message' && entry.message.role === 'system'
      ? [entry.message]
      : [],
  );
  expect(stored.length).toBe(1);
});

test('resume of a compacted session keeps the system message as the refresh baseline', async () => {
  // 第一个会话：产生系统消息并完成一轮对话后压缩。
  // 压缩切点只可能落在池化消息上，系统消息条目必然在保留区间之外
  const firstModel = new CapturingModel([
    {
      text: 'T'.repeat(120),
      toolCalls: [{ id: 'call-1', name: 'echo', input: {} }],
    },
    { text: 'F'.repeat(40) },
    // 压缩调用的摘要
    { text: '这是摘要。' },
  ]);
  const firstAgent = new Agent({
    modelApi: firstModel,
    tools: echoRegistry(),
  });
  const firstSession = openSession(firstAgent, undefined, {
    contextWindow: 1000,
    threshold: 0.8,
    retainRatio: 0.02,
  });
  firstSession.prompt('跑一下');
  await until(() => !firstSession.isStreaming);
  await firstSession.compact();
  await firstSession.dispose();

  const [projectDir] = readdirSync(join(bubbleHome, 'sessions'));
  const [fileName] = readdirSync(join(bubbleHome, 'sessions', projectDir!));
  const filePath = join(bubbleHome, 'sessions', projectDir!, fileName!);

  // 恢复：上下文里必须仍有那条系统消息，作为刷新基线
  const secondAgent = new Agent({
    modelApi: new CapturingModel([{ text: '继续' }]),
    tools: echoRegistry(),
  });
  const secondSession = openSession(secondAgent, filePath);
  expect(systemMessages(secondAgent.state.messages).length).toBe(1);

  // 内容没有漂移：首个 run 不再追加新的系统消息
  secondSession.prompt('继续');
  await until(() => !secondSession.isStreaming);
  expect(systemMessages(secondAgent.state.messages).length).toBe(1);

  // 落盘：文件里自始至终只有一条系统消息条目
  await secondSession.dispose();
  const entries = readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SessionEntry);
  const stored = entries.flatMap(entry =>
    entry.type === 'message' && entry.message.role === 'system'
      ? [entry.message]
      : [],
  );
  expect(stored.length).toBe(1);
});

test('compaction keeps only the latest system message in the projected context', async () => {
  const registry = echoRegistry();
  const model = new CapturingModel([
    {
      text: 'T'.repeat(120),
      toolCalls: [{ id: 'call-1', name: 'echo', input: {} }],
    },
    { text: 'F'.repeat(40) },
    // 第二个 run 的正常回复
    { text: '再来一轮' },
    // 压缩调用的摘要
    { text: '这是摘要。' },
  ]);
  const agent = new Agent({ modelApi: model, tools: registry });
  // 小 contextWindow + 小保留比例，让短对话也能压出非空的可摘要区间
  const session = openSession(agent, undefined, {
    contextWindow: 1000,
    threshold: 0.8,
    retainRatio: 0.02,
  });

  session.prompt('跑一下');
  await until(() => !session.isStreaming);

  registry.register(defineExtraTool('extra'));
  session.prompt('再来');
  await until(() => !session.isStreaming);
  expect(systemMessages(agent.state.messages).length).toBe(2);

  await session.compact();

  // 投影只保留最新的系统消息
  const systems = systemMessages(agent.state.messages);
  expect(systems.length).toBe(1);
  expect(
    systems[0]?.role === 'system' && systems[0].content.includes('extra'),
  ).toBe(true);
  expect(agent.state.messages[0]?.role).toBe('system');

  // 摘要侧信道的输入不含系统消息
  const summaryRequest = model.requests.at(-1);
  expect(summaryRequest?.every(message => message.role !== 'system')).toBe(
    true,
  );

  // 会话文件里两条系统消息原文都还在
  await session.dispose();
  const entries = readSessionEntries();
  const stored = entries.flatMap(entry =>
    entry.type === 'message' && entry.message.role === 'system'
      ? [entry.message]
      : [],
  );
  expect(stored.length).toBe(2);
});

test('mid-run compaction prunes the status bar run order and keeps only the latest system message', async () => {
  const registry = echoRegistry();
  const model = new CapturingModel([
    {
      text: 'A'.repeat(2000),
      toolCalls: [{ id: 'call-1', name: 'echo', input: {} }],
    },
    // 压缩调用的摘要
    { text: '这是摘要。' },
    { text: '完成。' },
  ]);
  const agent = new Agent({ modelApi: model, tools: registry });
  // 在第二个 turn 前注册新工具，让提示词刷新与循环内压缩发生在同一次 prepareTurn。
  // 先于会话的内置钩子注册，保证刷新能看到这次变化
  let injected = false;
  agent.registerHook({
    prepareTurn: context => {
      if (
        !injected &&
        context.messages.some(message => message.role === 'tool_result')
      ) {
        injected = true;
        registry.register(defineExtraTool('midrun'));
      }
    },
  });
  // 小 contextWindow + 小保留比例：第一个 turn 可摘要区间为空（静默跳过），
  // 第二个 turn 才能压出非空区间
  const session = openSession(agent, undefined, {
    contextWindow: 1000,
    threshold: 0.8,
    retainRatio: 0.02,
  });
  // 记录状态栏每次刷新的用量：压缩后被摘要掉的本轮消息不应再计入
  const readings: number[] = [];
  session.subscribe(event => {
    if (event.type === 'status_refresh') {
      readings.push(session.contextStats.usedTokens);
    }
  });

  session.prompt('U'.repeat(4000));
  await until(() => !session.isStreaming);

  // 投影：sys0 与 4000 字符的用户消息被摘要，只剩 sys1（含 midrun）与保留区间
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'user',
    'assistant',
    'tool_result',
    'system',
    'assistant',
  ]);
  const systems = systemMessages(agent.state.messages);
  expect(systems.length).toBe(1);
  expect(
    systems[0]?.role === 'system' && systems[0].content.includes('midrun'),
  ).toBe(true);

  // 三次请求：首轮带构造时的系统消息；摘要侧信道不带系统消息；
  // 压缩后的请求只有最新系统消息且在开头
  expect(model.requests.length).toBe(3);
  const firstSystem = model.requests[0]?.[0];
  expect(
    firstSystem?.role === 'system' && !firstSystem.content.includes('midrun'),
  ).toBe(true);
  expect(model.requests[1]?.every(message => message.role !== 'system')).toBe(
    true,
  );
  const third = model.requests[2];
  expect(systemMessages(third ?? []).length).toBe(1);
  expect(
    third?.[0]?.role === 'system' && third[0].content.includes('midrun'),
  ).toBe(true);

  // 状态栏：压缩前峰值包含 4000 字符的用户消息；压缩后它被摘要，
  // 用量必须回落（currentRunOrder 已剔除被摘要的本轮消息）
  expect(readings.length).toBeGreaterThanOrEqual(3);
  const peak = readings[1] ?? 0;
  const final = readings.at(-1) ?? Number.POSITIVE_INFINITY;
  expect(peak).toBeGreaterThan(2000);
  expect(final).toBeLessThan(peak);

  // 落盘：两条系统消息按生产顺序保留，压缩条目在第二条系统消息与最后一条 assistant 之间
  await session.dispose();
  const entries = readSessionEntries();
  const sequence = entries.flatMap(entry => {
    if (entry.type === 'message') {
      return [entry.message.role];
    }
    if (entry.type === 'compaction') {
      return ['compaction'];
    }
    return [];
  });
  expect(sequence).toEqual([
    'system',
    'user',
    'assistant',
    'tool_result',
    'system',
    'compaction',
    'assistant',
  ]);
});
