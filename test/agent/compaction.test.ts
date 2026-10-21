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
import {
  type CompactConfig,
  estimateContextTokens,
  findRetainedStart,
  SUMMARY_PREFIX,
} from '../../src/agent/compaction.ts';
import type { SessionEntry } from '../../src/agent/session-manager.ts';
import {
  type AgentMessage,
  type AssistantMessage,
  AssistantMessageEventStream,
  type ModelApi,
  type StreamOptions,
  type Text,
  type ToolCall,
  type Usage,
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

function systemNotices(session: AgentSession): string[] {
  return session.messages.flatMap(message =>
    message.role === 'system' ? [message.content] : [],
  );
}

function makeUsage(partial: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...partial,
  };
}

function userMessage(content: string): AgentMessage {
  return { role: 'user', content, timestamp: Date.now() };
}

function assistantText(text: string, usage?: Usage): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function assistantToolCall(id: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_call', id, name: 'read', input: {} }],
    stopReason: 'tool_use',
    timestamp: Date.now(),
  };
}

function toolResult(id: string, output: string): AgentMessage {
  return {
    role: 'tool_result',
    toolName: 'read',
    toolCallId: id,
    output,
    timestamp: Date.now(),
  };
}

test('context tokens anchor on the latest assistant usage and estimate the tail', () => {
  // 锚点之后只有估算增量：user 12 字符 → 3，tool_result 20 字符 → 5
  const messages: AgentMessage[] = [
    { role: 'system', content: 'x'.repeat(40) },
    userMessage('u'.repeat(8)),
    assistantText(
      'a'.repeat(16),
      makeUsage({ input: 1000, output: 100, cacheRead: 200, cacheWrite: 50 }),
    ),
    userMessage('v'.repeat(12)),
    toolResult('c1', 'o'.repeat(20)),
  ];
  expect(estimateContextTokens(messages)).toBe(1350 + 3 + 5);

  // totalTokens 非零时优先（pi-ai calculateContextTokens 的语义）
  const withTotal: AgentMessage[] = [
    assistantText('a', makeUsage({ totalTokens: 900 })),
    userMessage('v'.repeat(12)),
  ];
  expect(estimateContextTokens(withTotal)).toBe(900 + 3);

  // 没有锚点：全部按 chars/4 估算，system 也计入
  const noAnchor: AgentMessage[] = [
    { role: 'system', content: 'x'.repeat(40) },
    userMessage('u'.repeat(8)),
  ];
  expect(estimateContextTokens(noAnchor)).toBe(10 + 2);
});

test('cut point moves up so a retained tool_result keeps its assistant message', () => {
  const messages: AgentMessage[] = [
    { role: 'system', content: 's' },
    userMessage('u1'),
    assistantToolCall('c1'),
    toolResult('c1', 'o'.repeat(8)),
    userMessage('u2u2'),
    assistantText('a'.repeat(8)),
  ];

  // 预算 4 token：从尾部累积 2 + 1 + 2 后到达，候选 k 落在 tool_result（下标 3）上；
  // 工具配对安全把它挪到下标 2，保住 assistant 与它的 tool_result 不拆散
  expect(findRetainedStart(messages, 4, 1)).toBe(2);

  // 预算 2 token：只留最后一条 assistant，不涉及工具配对
  expect(findRetainedStart(messages, 2, 1)).toBe(5);

  // 预算覆盖全部消息：k 顶到下界，调用方据此判定「无需压缩」
  expect(findRetainedStart(messages, 10_000, 1)).toBe(1);
});

type ScriptTurn = {
  text?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
};

// 按剧本逐轮回放；压缩的摘要调用也走同一个 model，消耗下一轮剧本
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

// 流出一段文本后挂住，直到外部 abort
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

    if (options?.signal?.aborted) {
      abort();
    } else {
      options?.signal?.addEventListener('abort', abort, { once: true });
    }

    return stream;
  }
}

function echoRegistry(): ToolRegistry {
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
  return registry;
}

// 小 contextWindow + 小保留比例，让短对话也能压出非空的可摘要区间
const tinyCompactConfig: CompactConfig = {
  contextWindow: 1000,
  threshold: 0.8,
  retainRatio: 0.02,
};

test('manual compaction summarizes the old prefix and rejects a second compact without new messages', async () => {
  const model = new ScriptedModel([
    // 第一轮：长文本 + 工具调用，保证保留预算（20 token ≈ 80 字符）装不下全部
    {
      text: 'T'.repeat(120),
      toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hi' } }],
    },
    { text: 'F'.repeat(40) },
    // 压缩调用的摘要
    { text: '这是摘要。' },
  ]);
  const agent = new Agent({ modelApi: model, tools: echoRegistry() });
  const session = openSession(agent, undefined, tinyCompactConfig);

  session.prompt('跑一下');
  await until(() => !session.isStreaming);
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'system',
    'user',
    'assistant',
    'tool_result',
    'assistant',
  ]);

  await session.compact();

  // 投影：system + 摘要 user 消息 + 保留区间
  const roles = agent.state.messages.map(message => message.role);
  expect(roles).toEqual([
    'system',
    'user',
    'assistant',
    'tool_result',
    'assistant',
  ]);
  const summaryMessage = agent.state.messages[1];
  expect(summaryMessage?.role).toBe('user');
  expect(
    summaryMessage?.role === 'user' &&
      summaryMessage.content.startsWith(SUMMARY_PREFIX),
  ).toBe(true);
  expect(
    summaryMessage?.role === 'user' &&
      summaryMessage.content.includes('这是摘要。'),
  ).toBe(true);

  // 转录区保留全部原始消息，压缩点插入永久标记
  expect(
    systemNotices(session).some(content =>
      content.includes('上下文已压缩：前 1 条消息已摘要'),
    ),
  ).toBe(true);
  expect(
    session.messages.some(
      message => message.role === 'user' && message.content === '跑一下',
    ),
  ).toBe(true);

  // 没有新消息时再次手动压缩被拒绝
  await session.compact();
  expect(
    systemNotices(session).some(content =>
      content.includes('会话已压缩过，没有新的消息需要压缩'),
    ),
  ).toBe(true);
});

test('compaction entry is persisted and resume rebuilds the projected context', async () => {
  const model = new ScriptedModel([
    {
      text: 'T'.repeat(120),
      toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hi' } }],
    },
    { text: 'F'.repeat(40) },
    { text: '这是摘要。' },
  ]);
  const agent = new Agent({ modelApi: model, tools: echoRegistry() });
  const session = openSession(agent, undefined, tinyCompactConfig);

  session.prompt('跑一下');
  await until(() => !session.isStreaming);
  await session.compact();
  await session.dispose();

  const [projectDir] = readdirSync(join(bubbleHome, 'sessions'));
  const [fileName] = readdirSync(join(bubbleHome, 'sessions', projectDir!));
  const filePath = join(bubbleHome, 'sessions', projectDir!, fileName!);
  const entries = readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SessionEntry);

  // 压缩条目在文件尾部，摘要侧信道本身不落盘
  const compaction = entries.find(entry => entry.type === 'compaction');
  expect(compaction).toMatchObject({
    type: 'compaction',
    summary: '这是摘要。',
    summarizedCount: 1,
  });
  expect(
    compaction?.type === 'compaction' &&
      entries.some(
        entry =>
          entry.type === 'message' &&
          entry.id === compaction.firstRetainedEntryId,
      ),
  ).toBe(true);

  // 恢复：上下文 = system + 摘要 + 保留区间；转录区重建压缩标记
  const resumedAgent = new Agent({
    modelApi: new ScriptedModel([]),
    tools: echoRegistry(),
  });
  const resumedSession = openSession(resumedAgent, filePath, tinyCompactConfig);
  expect(resumedAgent.state.messages.map(message => message.role)).toEqual([
    'system',
    'user',
    'assistant',
    'tool_result',
    'assistant',
  ]);
  const resumedSummary = resumedAgent.state.messages[1];
  expect(
    resumedSummary?.role === 'user' &&
      resumedSummary.content === `${SUMMARY_PREFIX}这是摘要。`,
  ).toBe(true);
  expect(
    systemNotices(resumedSession).some(content =>
      content.includes('上下文已压缩：前 1 条消息已摘要'),
    ),
  ).toBe(true);
});

test('manual compaction on a short session falls back to keeping only the last turn', async () => {
  const model = new ScriptedModel([
    { text: '回答一' },
    { text: '回答二' },
    // 压缩调用的摘要
    { text: '这是摘要。' },
  ]);
  const agent = new Agent({ modelApi: model, tools: new ToolRegistry() });
  const session = openSession(agent);

  session.prompt('第一轮');
  await until(() => !session.isStreaming);
  session.prompt('第二轮');
  await until(() => !session.isStreaming);

  await session.compact();

  // 默认保留预算装得下全部消息，自然切点为空；回退为摘要到最后一条 user 消息
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'system',
    'user',
    'user',
    'assistant',
  ]);
  const summary = agent.state.messages[1];
  expect(
    summary?.role === 'user' &&
      summary.content === `${SUMMARY_PREFIX}这是摘要。`,
  ).toBe(true);
  const retainedUser = agent.state.messages[2];
  expect(
    retainedUser?.role === 'user' && retainedUser.content === '第二轮',
  ).toBe(true);
  expect(
    systemNotices(session).some(content =>
      content.includes('上下文已压缩：前 2 条消息已摘要'),
    ),
  ).toBe(true);
});

test('auto compaction fires inside the tool loop before the next stream when over threshold', async () => {
  const model = new ScriptedModel([
    {
      text: 'A'.repeat(120),
      toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hi' } }],
    },
    {
      text: 'B'.repeat(1000),
      toolCalls: [{ id: 'call-2', name: 'echo', input: { value: 'hi' } }],
    },
    // 循环内压缩的摘要调用消耗这一轮剧本
    { text: '这是摘要。' },
    { text: '完成。' },
  ]);
  const agent = new Agent({ modelApi: model, tools: echoRegistry() });
  const session = openSession(agent, undefined, tinyCompactConfig);

  session.prompt('跑一下');
  await until(() => !session.isStreaming);

  // 第三轮 stream 前超阈值就地压缩：system + 摘要 + 保留区间（第二轮）+ 第三轮结果
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'system',
    'user',
    'assistant',
    'tool_result',
    'assistant',
  ]);
  const summary = agent.state.messages[1];
  expect(
    summary?.role === 'user' &&
      summary.content === `${SUMMARY_PREFIX}这是摘要。`,
  ).toBe(true);

  // 被摘要的第一轮不再出现在上下文，保留区间与后续轮次照常
  const texts = agent.state.messages.flatMap(message =>
    message.role === 'assistant'
      ? message.content.flatMap(block =>
          block.type === 'text' ? [block.text] : [],
        )
      : [],
  );
  expect(texts.some(text => text.includes('A'.repeat(120)))).toBe(false);
  expect(texts.some(text => text.includes('B'.repeat(1000)))).toBe(true);
  expect(texts).toContain('完成。');
  expect(
    systemNotices(session).some(content =>
      content.includes('上下文已压缩：前 3 条消息已摘要'),
    ),
  ).toBe(true);

  // 文件顺序：压缩条目排在已持久化的第二轮条目之后、第三轮条目之前
  await session.dispose();
  const [projectDir] = readdirSync(join(bubbleHome, 'sessions'));
  const [fileName] = readdirSync(join(bubbleHome, 'sessions', projectDir!));
  const entries = readFileSync(
    join(bubbleHome, 'sessions', projectDir!, fileName!),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SessionEntry);
  const compactionIndex = entries.findIndex(
    entry => entry.type === 'compaction',
  );
  expect(compactionIndex).toBeGreaterThan(-1);
  const rolesBefore = entries
    .slice(0, compactionIndex)
    .flatMap(entry => (entry.type === 'message' ? [entry.message.role] : []));
  expect(rolesBefore).toEqual([
    'user',
    'assistant',
    'tool_result',
    'assistant',
    'tool_result',
  ]);
  const after = entries
    .slice(compactionIndex + 1)
    .filter(entry => entry.type === 'message');
  expect(after.length).toBe(1);
});

test('manual compaction is rejected while streaming', async () => {
  const agent = new Agent({
    modelApi: new HangingModel(),
    tools: new ToolRegistry(),
  });
  const session = openSession(agent);

  session.prompt('开始');
  await until(() => session.isStreaming);

  await session.compact();
  expect(
    systemNotices(session).some(content =>
      content.includes('请等待当前会话结束'),
    ),
  ).toBe(true);

  session.cancel();
  await until(() => !session.isStreaming);
});

function writeSessionFile(filePath: string, entries: SessionEntry[]): void {
  writeFileSync(
    filePath,
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
  );
}

function metaEntry(id: string): SessionEntry {
  return { type: 'metadata', id, cwd: process.cwd(), version: 1, timestamp: 1 };
}

let entryTimestamp = 2;
function messageEntry(id: string, message: AgentMessage): SessionEntry {
  return { type: 'message', id, timestamp: entryTimestamp++, message };
}

test('resume with one compaction entry projects summary plus retained tail', () => {
  const filePath = join(bubbleHome, 'session-compacted.jsonl');
  writeSessionFile(filePath, [
    metaEntry('compacted'),
    messageEntry('e1', userMessage('问题一')),
    messageEntry('e2', assistantText('回答一')),
    messageEntry('e3', userMessage('问题二')),
    messageEntry('e4', assistantText('回答二')),
    {
      type: 'compaction',
      id: 'c1',
      timestamp: entryTimestamp++,
      summary: '摘要一',
      summarizedCount: 2,
      firstRetainedEntryId: 'e3',
    },
    messageEntry('e5', userMessage('问题三')),
  ]);

  const agent = new Agent({ tools: new ToolRegistry() });
  const session = openSession(agent, filePath);

  // 上下文 = system + 摘要 + 保留区间（e3 起）+ 压缩后新增（e5）
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'system',
    'user',
    'user',
    'assistant',
    'user',
  ]);
  const summary = agent.state.messages[1];
  expect(
    summary?.role === 'user' && summary.content === `${SUMMARY_PREFIX}摘要一`,
  ).toBe(true);

  // 转录区：被摘要的消息仍然可见，压缩点有标记
  const notices = systemNotices(session);
  expect(
    notices.some(content =>
      content.includes('上下文已压缩：前 2 条消息已摘要'),
    ),
  ).toBe(true);
  expect(
    session.messages.some(
      message => message.role === 'user' && message.content === '问题一',
    ),
  ).toBe(true);
});

test('resume with two compaction entries uses only the last one for context', () => {
  const filePath = join(bubbleHome, 'session-twice.jsonl');
  writeSessionFile(filePath, [
    metaEntry('twice'),
    messageEntry('e1', userMessage('问题一')),
    {
      type: 'compaction',
      id: 'c1',
      timestamp: entryTimestamp++,
      summary: '摘要一',
      summarizedCount: 1,
      firstRetainedEntryId: 'e1',
    },
    messageEntry('e2', userMessage('问题二')),
    messageEntry('e3', assistantText('回答二')),
    {
      type: 'compaction',
      id: 'c2',
      timestamp: entryTimestamp++,
      summary: '摘要二',
      summarizedCount: 2,
      firstRetainedEntryId: 'e3',
    },
    messageEntry('e4', userMessage('问题三')),
  ]);

  const agent = new Agent({ tools: new ToolRegistry() });
  const session = openSession(agent, filePath);

  // 上下文 = system + 摘要二 + 保留区间（e3 起）+ 压缩后新增（e4）
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'system',
    'user',
    'assistant',
    'user',
  ]);
  const summary = agent.state.messages[1];
  expect(
    summary?.role === 'user' && summary.content === `${SUMMARY_PREFIX}摘要二`,
  ).toBe(true);

  // 两次压缩各留一条标记
  const markers = systemNotices(session).filter(content =>
    content.includes('上下文已压缩'),
  );
  expect(markers.length).toBe(2);
});

test('resume ignores a compaction entry whose retained id is missing', () => {
  const filePath = join(bubbleHome, 'session-corrupt.jsonl');
  writeSessionFile(filePath, [
    metaEntry('corrupt'),
    messageEntry('e1', userMessage('问题一')),
    messageEntry('e2', assistantText('回答一')),
    {
      type: 'compaction',
      id: 'c1',
      timestamp: entryTimestamp++,
      summary: '摘要一',
      summarizedCount: 1,
      firstRetainedEntryId: 'missing',
    },
    messageEntry('e3', userMessage('问题二')),
  ]);

  const agent = new Agent({ tools: new ToolRegistry() });
  openSession(agent, filePath);

  // 损坏的压缩条目被忽略：全部消息保留，没有摘要消息
  expect(agent.state.messages.map(message => message.role)).toEqual([
    'system',
    'user',
    'assistant',
    'user',
  ]);
});

test('compaction shows an in-progress line that is updated to the outcome', async () => {
  const model = new ScriptedModel([{ text: 'R'.repeat(200) }]);
  const agent = new Agent({ modelApi: model, tools: echoRegistry() });
  const session = openSession(agent, undefined, tinyCompactConfig);

  session.prompt('你好');
  await until(() => !session.isStreaming);

  // 换成挂起模型：压缩的摘要调用流出开头后停住，直到外部取消
  agent.state.modelApi = new HangingModel();
  void session.compact();
  await until(() =>
    systemNotices(session).some(content => content.includes('正在压缩上下文')),
  );

  session.cancel();
  await until(() =>
    systemNotices(session).some(content =>
      content.includes('上下文压缩已取消'),
    ),
  );

  // 临时行原地更新为结果：压缩相关的系统消息只有一行
  expect(
    systemNotices(session).filter(content => content.includes('压缩')).length,
  ).toBe(1);
});
