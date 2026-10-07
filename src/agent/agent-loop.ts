import type {
  AgentMessage,
  AssistantMessage,
  Model,
  ToolCall,
  ToolResultMessage,
} from '../llm/types.ts';
import type { AgentContext, AgentEvent } from './types.ts';

export type AgentLoopOptions = {
  maxSteps?: number;
};

// 事件发射器
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

const defaultMaxSteps = 30;

export async function runAgentLoop(
  // 本次运行的增量输入，暂时只支持文本输入，后期再考虑图片/文件引用。
  prompt: string,
  context: AgentContext,
  emit: AgentEventSink,
  model: Model,
  signal: AbortSignal | undefined,
  options?: AgentLoopOptions,
): Promise<AgentMessage[]> {
  // 本次运行新增消息
  const newMessages: AgentMessage[] = [
    {
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    },
  ];

  // 本轮运行时上下文
  const runContext: AgentContext = {
    ...context,
    // 本轮开始前的快照 + 本轮增量消息
    messages: [...context.messages, ...newMessages],
  };

  if (!options) {
    options = {
      maxSteps: defaultMaxSteps,
    };
  } else if (!options.maxSteps) {
    options.maxSteps = defaultMaxSteps;
  }

  await runLoop(runContext, options, emit, signal, model, newMessages);

  return newMessages;
}

// 返回本次运行新增的消息
async function runLoop(
  context: AgentContext,
  options: AgentLoopOptions,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  model: Model,
  newMessages: AgentMessage[],
): Promise<AgentMessage[]> {
  // 额外参数
  const streamOptions = {
    tools: context.tools.list(),
    signal,
  };
  await emit({ type: 'run_start' });
  let step = 0;
  while (step < options.maxSteps!) {
    // 上一步刚被取消就别再发起请求了
    if (signal?.aborted) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop -- 事件必须按顺序发出
    await emit({ type: 'turn_start' });

    // 本轮最终消息
    let message: AssistantMessage | undefined;
    // 本轮待执行的工具调用列表
    const waitingToolCalls: ToolCall[] = [];
    // 模型输出必须顺序消费，不能并发拉取。
    // eslint-disable-next-line no-await-in-loop
    for await (const event of model.stream(context.messages, streamOptions)) {
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
          // 工具调用开始
          await emit({
            type: 'tool_start',
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
          // 本轮结束
          await emit({
            type: 'turn_end',
            message: event.message,
            toolResults: [],
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

    const toolResults: ToolResultMessage[] = [];

    // 循环工具调用
    for (const { id, name, input } of waitingToolCalls) {
      let output: string;
      let success = false;
      try {
        // eslint-disable-next-line no-await-in-loop, unicorn/no-array-callback-reference -- 工具按顺序执行；ToolRegistry.find 不是 Array.find
        const result = await context.tools.find(name).execute(input);
        success = result.success;
        // 失败信息也要给模型看到，否则它不知道命令挂了
        output = result.success
          ? result.output
          : [result.error, result.output].filter(Boolean).join('\n');
      } catch (error: unknown) {
        // 工具不存在、或工具自己抛了，也要作为结果喂回去，模型才有机会纠正；
        output = `工具执行失败：${
          error instanceof Error ? error.message : String(error)
        }`;
      }

      const toolResultMessage: ToolResultMessage = {
        role: 'tool_result',
        toolName: name,
        toolCallId: id,
        output,
        timestamp: Date.now(),
      };
      // 工具调用结果,暂时没有流式
      // eslint-disable-next-line no-await-in-loop -- 事件必须按顺序发出
      await emit({
        type: 'tool_result',
        toolCallId: id,
        result: toolResultMessage,
        success,
      });
      toolResults.push(toolResultMessage);
      newMessages.push(toolResultMessage);
      // 往消息列表中添加工具调用结果消息
      context.messages.push(toolResultMessage);
    }

    // 本轮结束
    // eslint-disable-next-line no-await-in-loop -- 事件必须按顺序发出
    await emit({
      type: 'turn_end',
      message,
      toolResults,
    });

    step++;
  }

  if (signal?.aborted) {
    await emit({ type: 'run_end', reason: 'aborted', messages: newMessages });
  } else {
    await emit({
      type: 'run_end',
      reason: 'max_steps',
      error: new Error(`达到最大步数 ${options.maxSteps}，循环终止`),
      messages: newMessages,
    });
  }

  return newMessages;
}
