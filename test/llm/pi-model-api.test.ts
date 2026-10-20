import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent as PiAssistantMessageEvent,
} from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import {
  assembleModel,
  convertPiEvent,
  fromPiAssistantMessage,
  toPiContext,
} from '../../src/llm/api/pi-model-api.ts';
import type { Message } from '../../src/llm/types.ts';
import {
  loadSettings,
  type ProviderConfig,
} from '../../src/setting-manager.ts';

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: ZERO_COST,
};

function provider(partial: Partial<ProviderConfig>): ProviderConfig {
  return {
    name: 'acme',
    type: 'openai-completions',
    baseUrl: 'https://acme.example.com',
    apiKey: 'key',
    models: [{ id: 'acme-model' }],
    ...partial,
  };
}

function piMessage(
  content: PiAssistantMessage['content'],
  partial?: Partial<PiAssistantMessage>,
): PiAssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'acme',
    model: 'acme-model',
    content,
    usage: ZERO_USAGE,
    stopReason: 'stop',
    timestamp: 1,
    ...partial,
  };
}

// Model 装配

test('catalog 命中：元数据来自 catalog，settings 的 baseUrl 覆盖生效', () => {
  // provider 名大小写不敏感
  const model = assembleModel(provider({ name: 'DeepSeek' }), {
    id: 'deepseek-flash',
  });

  expect(model.provider).toBe('deepseek');
  expect(model.baseUrl).toBe('https://acme.example.com');
  // cost 与 compat 标志原样保留
  expect(model.cost.input).toBeCloseTo(0.3);
  expect(model.cost.cacheWrite).toBe(0);
  expect(model.compat).toBeDefined();
  expect(model.input).toEqual(['text', 'image']);
  expect(model.contextWindow).toBe(1_000_000);
  expect(model.maxTokens).toBe(384_000);
});

test('catalog 命中：settings 显式写的 name/maxTokens/input 覆盖 catalog', () => {
  const model = assembleModel(provider({ name: 'deepseek' }), {
    id: 'deepseek-flash',
    name: '我的 DeepSeek',
    maxTokens: 64_000,
    input: ['text'],
  });

  expect(model.name).toBe('我的 DeepSeek');
  expect(model.maxTokens).toBe(64_000);
  expect(model.input).toEqual(['text']);
  // 没写的字段跟随 catalog
  expect(model.contextWindow).toBe(1_000_000);
});

test('catalog 未命中：手工合成零成本兜底模型', () => {
  const model = assembleModel(
    provider({ name: 'acme', type: 'anthropic-messages' }),
    { id: 'acme-model' },
  );

  expect(model.id).toBe('acme-model');
  expect(model.api).toBe('anthropic-messages');
  expect(model.provider).toBe('acme');
  expect(model.baseUrl).toBe('https://acme.example.com');
  expect(model.cost).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  expect(model.input).toEqual(['text']);
  expect(model.maxTokens).toBe(128_000);
  expect(model.contextWindow).toBe(256_000);
  expect(model.reasoning).toBe(false);
});

test('catalog 协议与 settings type 不一致：退回手工合成，不继承 catalog 的 compat 标志', () => {
  const model = assembleModel(
    provider({ name: 'deepseek', type: 'anthropic-messages' }),
    { id: 'deepseek-flash' },
  );

  expect(model.api).toBe('anthropic-messages');
  expect(model.provider).toBe('deepseek');
  expect(model.cost.input).toBe(0);
  expect(model.compat).toBeUndefined();
});

test('reasoning 档位 → 能力布尔：配了档位即 true，没配跟随 catalog/兜底 false', () => {
  // catalog 模型本身 reasoning: true，不配档位保持 true
  expect(
    assembleModel(provider({ name: 'deepseek' }), { id: 'deepseek-flash' })
      .reasoning,
  ).toBe(true);

  // catalog 模型配了档位仍是 true（等价声明）
  expect(
    assembleModel(provider({ name: 'deepseek' }), {
      id: 'deepseek-flash',
      reasoning: 'low',
    }).reasoning,
  ).toBe(true);

  // 兜底模型没配档位 → false
  expect(assembleModel(provider({}), { id: 'acme-model' }).reasoning).toBe(
    false,
  );

  // 兜底模型配了档位 → true
  expect(
    assembleModel(provider({}), { id: 'acme-model', reasoning: 'high' })
      .reasoning,
  ).toBe(true);
});

// 消息正向转换

test('toPiContext：system 抽出拼接，user 直转', () => {
  const model = assembleModel(provider({}), { id: 'acme-model' });
  const messages: Message[] = [
    { role: 'system', content: '第一部分' },
    { role: 'system', content: '第二部分' },
    { role: 'user', content: '你好', timestamp: 100 },
  ];

  const context = toPiContext(messages, [], model);
  expect(context.systemPrompt).toBe('第一部分\n第二部分');
  expect(context.messages).toEqual([
    { role: 'user', content: '你好', timestamp: 100 },
  ]);
});

test('toPiContext：assistant 的 thinking signature 与 tool_call 正确转换', () => {
  const model = assembleModel(provider({}), { id: 'acme-model' });
  const messages: Message[] = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '结论' },
        {
          type: 'thinking',
          thinking: '推理过程',
          thinkingReplayData: 'sig-1',
        },
        {
          type: 'tool_call',
          id: 'call-1',
          name: 'bash',
          input: { command: 'ls' },
        },
      ],
      stopReason: 'tool_use',
      timestamp: 200,
    },
  ];

  const context = toPiContext(messages, [], model);
  expect(context.messages).toHaveLength(1);
  const converted = context.messages[0];
  if (converted?.role !== 'assistant') {
    throw new Error('expected assistant message');
  }

  expect(converted.api).toBe('openai-completions');
  expect(converted.provider).toBe('acme');
  expect(converted.model).toBe('acme-model');
  // usage 缺省补全零
  expect(converted.usage).toEqual(ZERO_USAGE);
  // tool_use → toolUse
  expect(converted.stopReason).toBe('toolUse');
  expect(converted.content).toEqual([
    { type: 'text', text: '结论' },
    {
      type: 'thinking',
      thinking: '推理过程',
      thinkingSignature: 'sig-1',
    },
    {
      type: 'toolCall',
      id: 'call-1',
      name: 'bash',
      arguments: { command: 'ls' },
    },
  ]);
});

test('toPiContext：tool_result 带 error 与 metadata 时 isError/details 正确', () => {
  const model = assembleModel(provider({}), { id: 'acme-model' });
  const messages: Message[] = [
    {
      role: 'tool_result',
      toolName: 'bash',
      toolCallId: 'call-1',
      output: '部分输出',
      error: '命令失败',
      metadata: { exitCode: 1 },
      timestamp: 300,
    },
  ];

  const context = toPiContext(messages, [], model);
  expect(context.messages).toEqual([
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'bash',
      content: [{ type: 'text', text: '命令失败\n部分输出' }],
      isError: true,
      details: { exitCode: 1 },
      timestamp: 300,
    },
  ]);
});

test('toPiContext：tools 转 pi Tool，JSON Schema 作 parameters', () => {
  const model = assembleModel(provider({}), { id: 'acme-model' });
  const context = toPiContext(
    [{ role: 'user', content: 'hi', timestamp: 1 }],
    [
      {
        name: 'bash',
        description: '执行命令',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' } },
        },
        execute: () => Promise.resolve({ success: true, output: '' }),
      },
    ],
    model,
  );

  expect(context.tools).toEqual([
    {
      name: 'bash',
      description: '执行命令',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
      },
    },
  ]);
});

// 消息反向转换

test('fromPiAssistantMessage：usage 直传、stopReason 反向映射', () => {
  const usage = {
    input: 10,
    output: 5,
    cacheRead: 3,
    cacheWrite: 2,
    cacheWrite1h: 1,
    reasoning: 4,
    totalTokens: 20,
    cost: {
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0.5,
      total: 4,
    },
  };
  const message = fromPiAssistantMessage(
    piMessage([{ type: 'text', text: 'hi' }], {
      usage,
      stopReason: 'toolUse',
      rawStopReason: 'tool_calls',
    }),
  );

  expect(message.usage?.reasoning).toBe(4);
  expect(message.usage?.cost.total).toBe(4);
  expect(message.stopReason).toBe('tool_use');
  expect(message.rawStopReason).toBe('tool_calls');
});

// 事件转换

test('text_delta：字段改名 contentIndex → index，delta 直传', () => {
  const event: PiAssistantMessageEvent = {
    type: 'text_delta',
    contentIndex: 2,
    delta: '片段',
    partial: piMessage([{ type: 'text', text: '前序片段' }]),
  };

  const converted = convertPiEvent(event);
  expect(converted).toEqual({
    type: 'text_delta',
    index: 2,
    delta: '片段',
    partial: expect.objectContaining({ role: 'assistant' }),
  });
});

test('thinking_end：signature 从 partial 取出存进 thinkingReplayData', () => {
  const event: PiAssistantMessageEvent = {
    type: 'thinking_end',
    contentIndex: 1,
    content: '完整推理',
    partial: piMessage([
      { type: 'text', text: '结论' },
      {
        type: 'thinking',
        thinking: '完整推理',
        thinkingSignature: 'sig-9',
      },
    ]),
  };

  const converted = convertPiEvent(event);
  if (converted.type !== 'thinking_end') {
    throw new Error('expected thinking_end');
  }

  expect(converted.index).toBe(1);
  expect(converted.thinking).toEqual({
    type: 'thinking',
    thinking: '完整推理',
    thinkingReplayData: 'sig-9',
  });
});

test('toolcall 三段：start 从 partial 取不完整对象，end 用权威 arguments', () => {
  const start: PiAssistantMessageEvent = {
    type: 'toolcall_start',
    contentIndex: 0,
    partial: piMessage([
      // 模拟流中间的不完整 ToolCall：arguments 还没解析出来
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'bash',
      } as PiAssistantMessage['content'][number],
    ]),
  };
  const convertedStart = convertPiEvent(start);
  if (convertedStart.type !== 'tool_call_start') {
    throw new Error('expected tool_call_start');
  }
  expect(convertedStart.toolCall).toEqual({
    type: 'tool_call',
    id: 'call-1',
    name: 'bash',
    input: {},
  });

  const delta: PiAssistantMessageEvent = {
    type: 'toolcall_delta',
    contentIndex: 0,
    delta: '{"command":',
    partial: piMessage([
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'bash',
      } as PiAssistantMessage['content'][number],
    ]),
  };
  const convertedDelta = convertPiEvent(delta);
  if (convertedDelta.type !== 'tool_call_delta') {
    throw new Error('expected tool_call_delta');
  }
  expect(convertedDelta.delta).toBe('{"command":');

  const end: PiAssistantMessageEvent = {
    type: 'toolcall_end',
    contentIndex: 0,
    toolCall: {
      type: 'toolCall',
      id: 'call-1',
      name: 'bash',
      arguments: { command: 'ls' },
    },
    partial: piMessage([
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'bash',
        arguments: { command: 'ls' },
      },
    ]),
  };
  const convertedEnd = convertPiEvent(end);
  if (convertedEnd.type !== 'tool_call_end') {
    throw new Error('expected tool_call_end');
  }
  expect(convertedEnd.toolCall).toEqual({
    type: 'tool_call',
    id: 'call-1',
    name: 'bash',
    input: { command: 'ls' },
  });
});

test('done：reason 映射 toolUse→tool_use、deferred→stop，usage 直传', () => {
  const usage = {
    ...ZERO_USAGE,
    input: 42,
    cost: { ...ZERO_COST, input: 0.1, total: 0.1 },
  };
  const doneToolUse: PiAssistantMessageEvent = {
    type: 'done',
    reason: 'toolUse',
    message: piMessage([], { usage }),
  };
  const convertedToolUse = convertPiEvent(doneToolUse);
  if (convertedToolUse.type !== 'done') {
    throw new Error('expected done');
  }
  expect(convertedToolUse.reason).toBe('tool_use');
  expect(convertedToolUse.message.usage?.input).toBe(42);

  const doneDeferred: PiAssistantMessageEvent = {
    type: 'done',
    reason: 'deferred',
    message: piMessage([]),
  };
  expect(convertPiEvent(doneDeferred)).toEqual(
    expect.objectContaining({ type: 'done', reason: 'stop' }),
  );
});

test('error：AssistantMessage 包成 Error，aborted 与否看 stopReason', () => {
  const errorEvent: PiAssistantMessageEvent = {
    type: 'error',
    reason: 'aborted',
    error: piMessage([], {
      stopReason: 'aborted',
      errorMessage: '请求被中止',
    }),
  };
  const converted = convertPiEvent(errorEvent);
  if (converted.type !== 'error') {
    throw new Error('expected error');
  }

  expect(converted.reason).toBe('aborted');
  expect(converted.error).toBeInstanceOf(Error);
  expect(converted.error.message).toBe('请求被中止');
  expect(converted.message.stopReason).toBe('aborted');
  expect(converted.message.errorMessage).toBe('请求被中止');

  const noMessage: PiAssistantMessageEvent = {
    type: 'error',
    reason: 'error',
    error: piMessage([], { stopReason: 'error' }),
  };
  const convertedNoMessage = convertPiEvent(noMessage);
  if (convertedNoMessage.type !== 'error') {
    throw new Error('expected error');
  }
  expect(convertedNoMessage.error.message).toBe('unknown error');
});

// settings schema（协议枚举与 reasoning 档位）

test('settings schema：reasoning 接受档位字符串，拒绝布尔', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bubble-settings-'));
  try {
    const valid = join(dir, 'valid.jsonc');
    await writeFile(
      valid,
      JSON.stringify({
        providers: [
          {
            name: 'acme',
            type: 'openai-completions',
            baseUrl: 'https://acme.example.com',
            apiKey: 'key',
            models: [{ id: 'acme-model', reasoning: 'medium' }],
          },
        ],
      }),
    );
    const settings = await loadSettings(valid);
    expect(settings.providers[0]?.models[0]?.reasoning).toBe('medium');

    const invalid = join(dir, 'invalid.jsonc');
    await writeFile(
      invalid,
      JSON.stringify({
        providers: [
          {
            name: 'acme',
            type: 'openai-completions',
            baseUrl: 'https://acme.example.com',
            apiKey: 'key',
            models: [{ id: 'acme-model', reasoning: true }],
          },
        ],
      }),
    );
    await expect(loadSettings(invalid)).rejects.toThrow('配置校验失败');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('settings schema：protocol 接受 anthropic-messages，拒绝 anthropic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bubble-settings-'));
  try {
    const valid = join(dir, 'valid.jsonc');
    await writeFile(
      valid,
      JSON.stringify({
        providers: [
          {
            name: 'acme',
            type: 'anthropic-messages',
            baseUrl: 'https://acme.example.com',
            apiKey: 'key',
            models: [{ id: 'acme-model' }],
          },
        ],
      }),
    );
    const settings = await loadSettings(valid);
    expect(settings.providers[0]?.type).toBe('anthropic-messages');

    const invalid = join(dir, 'invalid.jsonc');
    await writeFile(
      invalid,
      JSON.stringify({
        providers: [
          {
            name: 'acme',
            type: 'anthropic',
            baseUrl: 'https://acme.example.com',
            apiKey: 'key',
            models: [{ id: 'acme-model' }],
          },
        ],
      }),
    );
    await expect(loadSettings(invalid)).rejects.toThrow('配置校验失败');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
