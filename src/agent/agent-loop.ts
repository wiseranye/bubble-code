import {type Model} from '@bubble-code/model/llm.js';
import {type ToolRegistry} from '@bubble-code/tools/tool.js';
import {type Message, ToolCallRecord} from '@bubble-code/model/message.js';
import {type AgentEvent} from './events.js';

export type LoopOptions = {
  model: Model;
  tools: ToolRegistry;
  maxSteps?: number;
  signal?: AbortSignal;
};

const DEFAULT_MAX_STEPS = 30;

export async function* runAgentLoop(
  messages: Message[],
  {model, tools, maxSteps = DEFAULT_MAX_STEPS, signal}: LoopOptions,
): AsyncGenerator<AgentEvent> {
  // 额外参数
  const streamOptions = {
    tools: tools.list(),
    signal: signal,
  };
  let step = 0;
  while (step < maxSteps) {
    // 上一步刚被取消就别再发起请求了
    if (signal?.aborted) {
      break;
    }
    let assistant = '';
    // 本轮的工具调用：input 用来执行，record 原样写回历史
    const pending: Array<{
      record: ToolCallRecord;
      input: Record<string, unknown>;
    }> = [];
    // 模型输出必须顺序消费，不能并发拉取。
    // eslint-disable-next-line no-await-in-loop
    for await (const response of model.stream(messages, streamOptions)) {
      switch (response.type) {
        case 'text_delta': {
          assistant += response.text;
          yield {
            type: 'assistant_delta',
            text: response.text,
          } satisfies AgentEvent;
          break;
        }
        case 'tool_call': {
          const toolCall = response.toolCall;
          const tool = tools.find(response.toolCall.name);
          // 先只登记，等本轮结束后再执行
          pending.push({
            record: {
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.inputRaw,
            },
            input: toolCall.input,
          });
          // 工具调用开始
          yield {
            type: 'tool_start',
            name: tool.name,
            input: response.toolCall?.inputRaw ?? '',
            tool_call_id: response.toolCall.id,
          };
          break;
        }
        case 'error': {
          yield {type: 'error', error: response.error};
          break;
        }
        default: {
          break;
        }
      }
    }
    // 没有工具调用 = 模型给出最终回答，循环结束
    if (pending.length === 0) {
      if (assistant !== '') {
        messages.push({
          role: 'assistant',
          content: assistant,
        });
        yield {type: 'complete', output: assistant};
        return;
      }
    }
    // assistant 的 tool_calls 必须先于 tool 结果进历史，
    // 否则下一轮请求会因为 tool 消息找不到对应的 tool_calls 被 API 拒绝
    messages.push({
      role: 'assistant',
      content: assistant,
      extra: {
        tool_calls: pending.map(item => item.record),
      },
    });
    // 循环工具调用
    for (const {record, input} of pending) {
      let output: string;
      let success = false;
      try {
        const result = await tools.find(record.name).execute(input);
        success = result.success;
        // 失败信息也要给模型看到，否则它不知道命令挂了
        output = result.success
          ? result.output
          : [result.error, result.output].filter(Boolean).join('\n');
      } catch (error) {
        // 工具不存在、或工具自己抛了，也要作为结果喂回去，模型才有机会纠正；
        output = `工具执行失败：${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      // 工具调用结果
      yield {
        type: 'tool_result',
        name: record.name,
        output,
        success,
        tool_call_id: record.id,
      };
      // 工具调用结束
      yield {
        type: 'tool_end',
        tool_call_id: record.id,
      };
      // 往消息列表中添加消息
      messages.push({
        role: 'tool',
        content: output,
        extra: {tool_call_id: record.id},
      });
    }

    step++;
  }

  if (!signal?.aborted) {
    yield {
      type: 'error',
      error: new Error(`达到最大步数 ${maxSteps}，循环终止`),
    };
  }
}
