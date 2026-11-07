import type {
  AgentMessage,
  AssistantMessage,
  ModelApi,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '../llm/types.ts';
import { projectSendView } from './send-view.ts';
import { executeToolCallBatch, skipToolCallBatch } from './tool-call-batch.ts';
import type { AgentContext, AgentEvent } from './types.ts';

// run / turn 生命周期钩子。prepareRun 在每次 run 开始、用户消息进入历史之前触发；
// prepareTurn 在每次模型请求之前触发（系统提示词刷新、循环内压缩都挂在这里）。
// 同一时机的钩子按注册顺序串行执行；单个钩子抛错只记日志，不中断 run
export interface AgentLoopHookContext {
  // run = prepareRun（写入 state 消息列表）；turn = prepareTurn（写入 run 的活动列表与增量）
  readonly phase: 'run' | 'turn';
  readonly signal: AbortSignal | undefined;
  // 当前生效的消息列表；用 appendMessage / replaceMessages 修改，不要直接改数组
  readonly messages: readonly AgentMessage[];
  // 追加一条消息：turn 阶段同时进入 run 增量，run 结束时并入 state
  appendMessage(message: AgentMessage): void;
  // 原地替换消息列表；turn 阶段会把 run 增量中不在替换结果里的消息一并剔除
  replaceMessages(projected: AgentMessage[]): void;
}

export interface AgentLoopHook {
  prepareRun?(context: AgentLoopHookContext): Promise<void> | void;
  prepareTurn?(context: AgentLoopHookContext): Promise<void> | void;
}

export type AgentLoopOptions = {
  hooks?: readonly AgentLoopHook[];
  maxConcurrentToolCalls?: number;
};

// 依次触发钩子；单个钩子失败只警告，不影响后续钩子与本次 run
export async function fireAgentLoopHooks(
  hooks: readonly AgentLoopHook[],
  method: 'prepareRun' | 'prepareTurn',
  context: AgentLoopHookContext,
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook[method]?.(context);
    } catch (error: unknown) {
      console.error(`agent 钩子 ${method} 执行失败:`, error);
    }
  }
}

// prepareRun 的上下文：直接读写 state 消息列表
export function stateHookContext(
  messages: AgentMessage[],
  signal: AbortSignal | undefined,
): AgentLoopHookContext {
  return {
    phase: 'run',
    signal,
    messages,
    appendMessage(message) {
      messages.push(message);
    },
    replaceMessages(projected) {
      messages.splice(0, messages.length, ...projected);
    },
  };
}

// prepareTurn 的上下文：写入 run 的活动列表与增量
function runHookContext(
  messages: AgentMessage[],
  newMessages: AgentMessage[],
  signal: AbortSignal | undefined,
): AgentLoopHookContext {
  return {
    phase: 'turn',
    signal,
    messages,
    appendMessage(message) {
      messages.push(message);
      newMessages.push(message);
    },
    replaceMessages(projected) {
      messages.splice(0, messages.length, ...projected);
      const retained = new Set(projected);
      for (let index = newMessages.length - 1; index >= 0; index--) {
        const message = newMessages[index];
        if (message !== undefined && !retained.has(message)) {
          newMessages.splice(index, 1);
        }
      }
    },
  };
}

// 事件发射器
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export async function runAgentLoop(
  // 本次运行的增量输入，由调用方构造并持久化（压缩要引用它的条目 id），
  // 暂时只支持文本输入，后期再考虑图片/文件引用。
  prompt: UserMessage,
  context: AgentContext,
  emit: AgentEventSink,
  modelApi: ModelApi,
  signal: AbortSignal | undefined,
  options?: AgentLoopOptions,
): Promise<AgentMessage[]> {
  // 本次运行新增消息
  const newMessages: AgentMessage[] = [prompt];

  // 本轮运行时上下文
  const runContext: AgentContext = {
    ...context,
    // 本轮开始前的快照 + 本轮增量消息
    messages: [...context.messages, ...newMessages],
  };

  if (!options) {
    options = {};
  }

  await runLoop(runContext, options, emit, signal, modelApi, newMessages);

  return newMessages;
}

// 返回本次运行新增的消息
async function runLoop(
  context: AgentContext,
  options: AgentLoopOptions,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  modelApi: ModelApi,
  newMessages: AgentMessage[],
): Promise<AgentMessage[]> {
  // 额外参数
  const streamOptions = {
    tools: context.tools.list(),
    signal,
  };
  const hooks = options.hooks ?? [];
  // 钩子写操作的落点：run 的活动消息列表与增量
  const hookContext = runHookContext(context.messages, newMessages, signal);
  await emit({ type: 'run_start' });
  while (true) {
    // 上一步刚被取消就别再发起请求了
    if (signal?.aborted) {
      break;
    }

    // 每个 turn 的请求前检查点：系统提示词刷新、循环内压缩都在这里
    // （压缩见 ADR 0004，钩子机制见 ADR 0005）
    if (hooks.length > 0) {
      // eslint-disable-next-line no-await-in-loop -- 请求前的串行检查点
      await fireAgentLoopHooks(hooks, 'prepareTurn', hookContext);

      // 钩子执行期间按 Esc 取消的是整个 run
      if (signal?.aborted) {
        break;
      }
    }

    // eslint-disable-next-line no-await-in-loop -- 事件必须按顺序发出
    await emit({ type: 'turn_start' });

    // 本轮最终消息
    let message: AssistantMessage | undefined;
    // 本轮待执行的工具调用列表
    const waitingToolCalls: ToolCall[] = [];
    // 发送视图：存储列表里可能有多条系统消息，只发最后一条并移到开头（ADR 0005）。
    // 模型输出必须顺序消费，不能并发拉取。
    // eslint-disable-next-line no-await-in-loop
    for await (const event of modelApi.stream(
      projectSendView(context.messages),
      streamOptions,
    )) {
      switch (event.type) {
        // 流式增量
        case 'text_delta': {
          await emit({
            type: 'text_delta',
            delta: event.delta,
          });
          break;
        }

        case 'text_end': {
          await emit({
            type: 'text_end',
            text: event.text,
          });
          break;
        }

        case 'thinking_delta': {
          await emit({
            type: 'thinking_delta',
            delta: event.delta,
          });
          break;
        }

        case 'thinking_end': {
          await emit({
            type: 'thinking_end',
            thinking: event.thinking,
          });
          break;
        }

        // 暂时只关心工具消息最终结果
        case 'tool_call_end': {
          const { toolCall } = event;
          // 先只登记，等本轮结束后再执行
          waitingToolCalls.push(toolCall);
          // 完整调用立即进入 Transcript，但要等获得执行槽位后才变为 running
          await emit({
            type: 'tool_queued',
            toolCall,
          });
          break;
        }

        case 'done': {
          message = event.message;
          newMessages.push(event.message);
          context.messages.push(event.message);
          break;
        }

        case 'error': {
          // 已完整接收的调用必须保留并补齐结果；尚未完整的流式调用不在批次内。
          let toolResults: ToolResultMessage[] = [];
          if (waitingToolCalls.length > 0) {
            newMessages.push(event.message);
            context.messages.push(event.message);
            toolResults = await skipToolCallBatch(
              waitingToolCalls,
              event.reason === 'aborted'
                ? 'user aborted'
                : 'model response failed; tool call was not executed',
              emit,
            );
            newMessages.push(...toolResults);
            context.messages.push(...toolResults);
          }
          // 本轮结束
          await emit({
            type: 'turn_end',
            message: event.message,
            toolResults,
          });
          await emit({
            type: 'run_end',
            reason: event.reason === 'aborted' ? 'aborted' : 'error',
            error: event.error,
            messages: newMessages,
          });
          return newMessages;
        }

        default: {
          break;
        }
      }
    }

    // 没有工具调用 = 模型给出最终回答，循环结束
    if (waitingToolCalls.length === 0) {
      // 本轮结束
      // eslint-disable-next-line no-await-in-loop -- 事件必须按顺序发出
      await emit({ type: 'turn_end', message, toolResults: [] });
      // eslint-disable-next-line no-await-in-loop -- 事件必须按顺序发出
      await emit({
        type: 'run_end',
        reason: 'complete',
        messages: newMessages,
      });
      return newMessages;
    }

    const toolResults = await executeToolCallBatch(waitingToolCalls, {
      context,
      signal,
      maxConcurrentCalls: options.maxConcurrentToolCalls ?? 10,
      emit,
    });
    // 完成事件可以乱序，但协议历史、持久化与下一次模型输入保持声明顺序。
    newMessages.push(...toolResults);
    context.messages.push(...toolResults);

    // 本轮结束
    // eslint-disable-next-line no-await-in-loop -- 事件必须按顺序发出
    await emit({
      type: 'turn_end',
      message,
      toolResults,
    });
  }

  if (signal?.aborted) {
    await emit({ type: 'run_end', reason: 'aborted', messages: newMessages });
  } else {
    throw new Error('unexpected stop in agent-loop!');
  }

  return newMessages;
}
