import type {
  Api,
  JsonObject,
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent as PiAssistantMessageEvent,
  AssistantMessageEventStream as PiAssistantMessageEventStream,
  Context as PiContext,
  Message as PiMessage,
  Model as PiModel,
  StopReason as PiStopReason,
  Tool as PiTool,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import { streamSimple as anthropicMessagesStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { streamSimple as openAiCompletionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as openAiResponsesStream } from '@earendil-works/pi-ai/api/openai-responses';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { ModelConfig, ProviderConfig } from '../../setting-manager.ts';
import type { AnyTool } from '../../tools/types.ts';
import { toolResultContent } from '../tool-result.ts';
import {
  type AssistantMessage,
  AssistantMessageEventStream,
  type Message,
  type ModelApi,
  type StopReason,
  type StreamChunkEvent,
  type StreamOptions,
  type ToolCall,
  type Usage,
} from '../types.ts';

// pi ↔ 项目的 stopReason 集中映射。pi 的 pending 是流中间的占位状态，正常不会落在
// 终止事件上；deferred 是长任务挂起。两者在项目都没有对应概念（ADR 0003），归入 stop。
const PI_TO_PROJECT_STOP_REASON: Record<PiStopReason, StopReason> = {
  pending: 'stop',
  stop: 'stop',
  length: 'length',
  toolUse: 'tool_use',
  error: 'error',
  aborted: 'aborted',
  deferred: 'stop',
};

export function toProjectStopReason(reason: PiStopReason): StopReason {
  return PI_TO_PROJECT_STOP_REASON[reason];
}

export function toPiStopReason(reason: StopReason): PiStopReason {
  return reason === 'tool_use' ? 'toolUse' : reason;
}

// 查 pi builtin catalog：provider 名大小写不敏感地对齐 builtin provider id，模型按 id 精确匹配
export function findCatalogModel(
  providerName: string,
  modelId: string,
): PiModel<Api> | undefined {
  const catalog = builtinModels();
  const provider = catalog
    .getProviders()
    .find(
      candidate => candidate.id.toLowerCase() === providerName.toLowerCase(),
    );
  return provider?.getModels().find(candidate => candidate.id === modelId);
}

// 把 settings 里的 provider/model 装配成 pi 的 Model：catalog 命中则以 catalog 条目为基础
// （保留 cost、compat 等元数据），settings 显式写的字段覆盖；未命中则手工合成兜底值
export function assembleModel(
  provider: ProviderConfig,
  modelConfig: ModelConfig,
): PiModel<Api> {
  const catalogModel = findCatalogModel(provider.name, modelConfig.id);
  // catalog 条目只在协议一致时可用：compat 标志是协议相关的，settings 的 type 与
  // catalog 的 api 不一致时继承过来反而是错的，退回手工合成
  const base: PiModel<Api> =
    catalogModel?.api === provider.type
      ? catalogModel
      : {
          id: modelConfig.id,
          name: modelConfig.name ?? modelConfig.id,
          api: provider.type,
          provider: provider.name,
          baseUrl: provider.baseUrl,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          contextWindow: 256_000,
          maxTokens: 128_000,
        };

  return {
    ...base,
    // baseUrl 无条件覆盖：provider.baseUrl 在 schema 里是必填，用户配了就是要用
    baseUrl: provider.baseUrl,
    name: modelConfig.name ?? base.name,
    input: modelConfig.input ?? base.input,
    maxTokens: modelConfig.maxTokens ?? base.maxTokens,
    contextWindow: modelConfig.contextWindow ?? base.contextWindow,
    // 配了思考档位即视为声明思考能力；没配跟随 catalog，catalog 没有则为 false
    reasoning: modelConfig.reasoning !== undefined ? true : base.reasoning,
  };
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toPiContentBlock(
  block: AssistantMessage['content'][number],
): PiAssistantMessage['content'][number] {
  switch (block.type) {
    case 'text': {
      return { type: 'text', text: block.text };
    }

    case 'thinking': {
      // thinkingReplayData 的语义就是 pi 的 thinkingSignature（ADR 0003）
      return {
        type: 'thinking',
        thinking: block.thinking,
        thinkingSignature: block.thinkingReplayData,
      };
    }

    case 'tool_call': {
      return {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: block.input as JsonObject,
      };
    }
  }
}

// 项目 assistant 消息 → pi：pi 的 AssistantMessage 强制要求 api/provider/model/usage，
// 用适配器持有的 model 信息补齐，usage 用消息自带或全零
export function toPiAssistantMessage(
  message: AssistantMessage,
  model: PiModel<Api>,
): PiAssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: message.content.map(toPiContentBlock),
    usage: message.usage ?? ZERO_USAGE,
    stopReason: toPiStopReason(message.stopReason),
    rawStopReason: message.rawStopReason,
    errorMessage: message.errorMessage,
    timestamp: message.timestamp,
  };
}

function fromPiContentBlock(
  block: PiAssistantMessage['content'][number],
): AssistantMessage['content'][number] {
  switch (block.type) {
    case 'text': {
      return { type: 'text', text: block.text };
    }

    case 'thinking': {
      return {
        type: 'thinking',
        thinking: block.thinking,
        thinkingReplayData: block.thinkingSignature,
      };
    }

    case 'toolCall': {
      return {
        type: 'tool_call',
        id: block.id,
        name: block.name,
        input: block.arguments,
      };
    }
  }
}

export function fromPiAssistantMessage(
  message: PiAssistantMessage,
): AssistantMessage {
  return {
    role: 'assistant',
    content: message.content.map(fromPiContentBlock),
    usage: message.usage,
    stopReason: toProjectStopReason(message.stopReason),
    rawStopReason: message.rawStopReason,
    errorMessage: message.errorMessage,
    timestamp: message.timestamp,
  };
}

// 项目消息列表 → pi Context：system 消息抽出拼成 systemPrompt，其余逐条转换
export function toPiContext(
  messages: Message[],
  tools: AnyTool[],
  model: PiModel<Api>,
): PiContext {
  const systemParts: string[] = [];
  const piMessages: PiMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        systemParts.push(message.content);
        break;
      }

      case 'user': {
        piMessages.push({
          role: 'user',
          content: message.content,
          timestamp: message.timestamp,
        });
        break;
      }

      case 'assistant': {
        piMessages.push(toPiAssistantMessage(message, model));
        break;
      }

      case 'tool_result': {
        piMessages.push({
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: [{ type: 'text', text: toolResultContent(message) }],
          isError: message.error !== undefined,
          details: message.metadata as JsonObject | undefined,
          timestamp: message.timestamp,
        });
        break;
      }
    }
  }

  const systemPrompt =
    systemParts.length > 0 ? systemParts.join('\n') : undefined;

  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    messages: piMessages,
    ...(tools.length > 0
      ? {
          tools: tools.map(
            (tool): PiTool => ({
              name: tool.name,
              description: tool.description,
              // 项目的 inputSchema 是 JSON Schema 对象，pi 要 typebox TSchema，运行时同构
              parameters: tool.inputSchema as PiTool['parameters'],
            }),
          ),
        }
      : {}),
  };
}

// toolcall_start/delta 没有完整 toolCall 对象，从 partial 里取（可能不完整）；
// arguments 缺/非法时兜底 {}，等 toolcall_end 的权威对象
function toolCallFromPartial(
  partial: PiAssistantMessage,
  contentIndex: number,
): ToolCall {
  const block = partial.content[contentIndex];
  if (block?.type !== 'toolCall') {
    return { type: 'tool_call', id: '', name: '', input: {} };
  }

  return {
    type: 'tool_call',
    id: block.id,
    name: block.name,
    input: isJsonObject(block.arguments) ? block.arguments : {},
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// pi 流事件 → 项目流事件：重命名、contentIndex → index、补 authoritative 内容。
// 纯函数，pi 事件序列可离线单测
export function convertPiEvent(
  event: PiAssistantMessageEvent,
): StreamChunkEvent {
  switch (event.type) {
    case 'start': {
      return { type: 'start', partial: fromPiAssistantMessage(event.partial) };
    }

    case 'text_start': {
      return {
        type: 'text_start',
        index: event.contentIndex,
        partial: fromPiAssistantMessage(event.partial),
      };
    }

    case 'text_delta': {
      return {
        type: 'text_delta',
        index: event.contentIndex,
        delta: event.delta,
        partial: fromPiAssistantMessage(event.partial),
      };
    }

    case 'text_end': {
      return {
        type: 'text_end',
        index: event.contentIndex,
        text: { type: 'text', text: event.content },
        partial: fromPiAssistantMessage(event.partial),
      };
    }

    case 'thinking_start': {
      return {
        type: 'thinking_start',
        index: event.contentIndex,
        partial: fromPiAssistantMessage(event.partial),
      };
    }

    case 'thinking_delta': {
      return {
        type: 'thinking_delta',
        index: event.contentIndex,
        delta: event.delta,
        partial: fromPiAssistantMessage(event.partial),
      };
    }

    case 'thinking_end': {
      const block = event.partial.content[event.contentIndex];
      return {
        type: 'thinking_end',
        index: event.contentIndex,
        thinking: {
          type: 'thinking',
          thinking: event.content,
          // signature 只在流末尾随完整 block 出现，存进 thinkingReplayData 供下轮回放
          thinkingReplayData:
            block?.type === 'thinking' ? block.thinkingSignature : undefined,
        },
        partial: fromPiAssistantMessage(event.partial),
      };
    }

    case 'toolcall_start': {
      return {
        type: 'tool_call_start',
        index: event.contentIndex,
        toolCall: toolCallFromPartial(event.partial, event.contentIndex),
        partial: fromPiAssistantMessage(event.partial),
      };
    }

    case 'toolcall_delta': {
      return {
        type: 'tool_call_delta',
        index: event.contentIndex,
        delta: event.delta,
        toolCall: toolCallFromPartial(event.partial, event.contentIndex),
        partial: fromPiAssistantMessage(event.partial),
      };
    }

    case 'toolcall_end': {
      return {
        type: 'tool_call_end',
        index: event.contentIndex,
        toolCall: {
          type: 'tool_call',
          id: event.toolCall.id,
          name: event.toolCall.name,
          input: event.toolCall.arguments,
        },
        partial: fromPiAssistantMessage(event.partial),
      };
    }

    case 'done': {
      // event.reason 只会是 stop/length/toolUse/deferred，表中映射结果必为这三种
      const reason = toProjectStopReason(event.reason) as
        | 'stop'
        | 'length'
        | 'tool_use';
      return {
        type: 'done',
        reason,
        message: fromPiAssistantMessage(event.message),
      };
    }

    case 'error': {
      // pi 的 error 事件携带的是 AssistantMessage 而不是 Error（ADR 0003），这里包一层
      const message = event.error;
      return {
        type: 'error',
        reason: message.stopReason === 'aborted' ? 'aborted' : 'error',
        error: new Error(message.errorMessage ?? 'unknown error'),
        message: fromPiAssistantMessage(message),
      };
    }
  }
}

export class PiModelApi implements ModelApi {
  private readonly provider: ProviderConfig;

  private readonly modelConfig: ModelConfig;

  private readonly model: PiModel<Api>;

  constructor(provider: ProviderConfig, model: ModelConfig) {
    this.provider = provider;
    this.modelConfig = model;
    this.model = assembleModel(provider, model);
  }

  stream(
    messages: Message[],
    options?: StreamOptions,
  ): AssistantMessageEventStream {
    const output = new AssistantMessageEventStream();
    const transcript = normalizeContext(
      toPiContext(messages, options?.tools ?? [], this.model),
    );
    const streamOptions: SimpleStreamOptions = {
      // per-request apiKey 直传，短路 pi 的 credential/env 解析（ADR 0003）
      apiKey: this.provider.apiKey,
      signal: options?.signal,
      // ADR 0003：anthropic 的 cache write 有成本，先固定最短档，不暴露配置
      cacheRetention: 'short',
      ...(this.modelConfig.reasoning !== undefined
        ? { reasoning: this.modelConfig.reasoning }
        : {}),
    };

    let current: AssistantMessage | undefined;
    (async () => {
      try {
        const piStream = this.dispatch(transcript, streamOptions);
        for await (const event of piStream) {
          const converted = convertPiEvent(event);
          if (converted.type !== 'done' && converted.type !== 'error') {
            current = converted.partial;
          }
          output.push(converted);
        }
        output.end();
      } catch (error: unknown) {
        // pi 流自己抛异常（网络错误等）时没有 error 事件可转，这里兜底包一层
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        const aborted = options?.signal?.aborted === true;
        const message: AssistantMessage = current ?? {
          role: 'assistant',
          content: [],
          stopReason: aborted ? 'aborted' : 'error',
          timestamp: Date.now(),
        };
        message.stopReason = aborted ? 'aborted' : 'error';
        message.errorMessage = normalizedError.message;
        output.push({
          type: 'error',
          reason: message.stopReason,
          error: normalizedError,
          message,
        });
        output.end();
      }
    })();

    return output;
  }

  private dispatch(
    transcript: TranscriptContext,
    options: SimpleStreamOptions,
  ): PiAssistantMessageEventStream {
    switch (this.provider.type) {
      case 'openai-completions': {
        return openAiCompletionsStream(
          this.model as PiModel<'openai-completions'>,
          transcript,
          options,
        );
      }

      case 'anthropic-messages': {
        return anthropicMessagesStream(
          this.model as PiModel<'anthropic-messages'>,
          transcript,
          options,
        );
      }

      case 'openai-responses': {
        return openAiResponsesStream(
          this.model as PiModel<'openai-responses'>,
          transcript,
          options,
        );
      }
    }
  }
}
