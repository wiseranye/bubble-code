import type { ToolCall, ToolResultMessage } from '../llm/types.ts';
import type { AgentContext, AgentEvent } from './types.ts';

type Emit = (event: AgentEvent) => Promise<void> | void;

type ToolExecutionOutcome = {
  result: ToolResultMessage;
  success: boolean;
};

export type ToolCallBatchOptions = {
  context: AgentContext;
  signal?: AbortSignal;
  maxConcurrentCalls: number;
  emit: Emit;
};

// 所有谓词先于任何工具执行；任一异常或未知工具都保守降级为整批串行。
function isBatchConcurrencySafe(
  calls: readonly ToolCall[],
  context: AgentContext,
): boolean {
  for (const call of calls) {
    const tool = context.tools.get(call.name);
    if (tool === undefined) {
      return false;
    }
    try {
      if (!tool.isConcurrencySafe(call.input)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function executeToolCall(
  call: ToolCall,
  context: AgentContext,
  signal: AbortSignal | undefined,
): Promise<ToolExecutionOutcome> {
  let output = '';
  let error: string | undefined;
  let metadata: Record<string, unknown> | undefined;
  let success = false;
  try {
    const result = await context.tools.find(call.name).execute(call.input, {
      cwd: context.cwd,
      toolCallId: call.id,
      signal,
      ui: context.ui,
    });
    success = result.success;
    // error 和 output 分开保留；拼成模型可见文本的事在 llm 适配层做
    output = result.output;
    error = result.error;
    metadata = result.metadata;
  } catch (failure: unknown) {
    // 工具不存在、或工具自己抛了，也要作为结果喂回去，模型才有机会纠正
    output = `工具执行失败：${
      failure instanceof Error ? failure.message : String(failure)
    }`;
  }

  return {
    result: {
      role: 'tool_result',
      toolName: call.name,
      toolCallId: call.id,
      output,
      error,
      metadata,
      timestamp: Date.now(),
    },
    success,
  };
}

function skippedToolCall(call: ToolCall, error: string): ToolExecutionOutcome {
  return {
    result: {
      role: 'tool_result',
      toolName: call.name,
      toolCallId: call.id,
      output: '',
      error,
      timestamp: Date.now(),
    },
    success: false,
  };
}

async function emitToolResult(
  call: ToolCall,
  outcome: ToolExecutionOutcome,
  emit: Emit,
): Promise<void> {
  await emit({
    type: 'tool_result',
    toolCallId: call.id,
    result: outcome.result,
    success: outcome.success,
  });
}

// 模型流已经终止时，本批不会启动任何工具，但完整调用仍必须有配对结果。
export async function skipToolCallBatch(
  calls: readonly ToolCall[],
  error: string,
  emit: Emit,
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];
  for (const call of calls) {
    const outcome = skippedToolCall(call, error);
    results.push(outcome.result);
    // eslint-disable-next-line no-await-in-loop -- UI 按批次声明顺序接收这些未执行结果
    await emitToolResult(call, outcome, emit);
  }
  return results;
}

// 安全批次滚动补位；不安全批次只把槽位限制为 1，仍复用相同的取消与结果配对逻辑。
export async function executeToolCallBatch(
  calls: readonly ToolCall[],
  { context, signal, maxConcurrentCalls, emit }: ToolCallBatchOptions,
): Promise<ToolResultMessage[]> {
  const outcomes: Array<ToolExecutionOutcome | undefined> = Array.from({
    length: calls.length,
  });
  const concurrency = isBatchConcurrencySafe(calls, context)
    ? maxConcurrentCalls
    : 1;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (!signal?.aborted) {
      const index = nextIndex++;
      if (index >= calls.length) {
        return;
      }
      const call = calls[index]!;

      // running 只在真正获得执行槽位后开始；queued 由模型流事件提前创建。
      // eslint-disable-next-line no-await-in-loop -- 同一工作槽位的事件必须按顺序通知
      await emit({ type: 'tool_start', toolCall: call });
      // emit 等待期间可能收到 Abort；此时不进入 execute，由下方统一补取消结果。
      if (signal?.aborted) {
        return;
      }

      // eslint-disable-next-line no-await-in-loop -- 每个工作槽位一次只执行一个调用
      const outcome = await executeToolCall(call, context, signal);
      outcomes[index] = outcome;
      // eslint-disable-next-line no-await-in-loop -- UI 可立即按完成顺序更新，协议数组仍按 index 排序
      await emitToolResult(call, outcome, emit);
    }
  }

  const workerCount = Math.min(concurrency, calls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Abort 后不再补位；已启动者均已 settle，其余调用在协议与 UI 中也不能悬空。
  for (const [index, call] of calls.entries()) {
    if (outcomes[index] !== undefined) {
      continue;
    }
    if (!signal?.aborted) {
      throw new Error('tool call batch ended with missing results');
    }
    const outcome = skippedToolCall(call, 'user aborted');
    outcomes[index] = outcome;
    // eslint-disable-next-line no-await-in-loop -- 取消结果按声明顺序补齐，避免重复或遗漏
    await emitToolResult(call, outcome, emit);
  }

  return outcomes.map((outcome, index) => {
    if (outcome === undefined) {
      throw new Error(`missing tool result at batch index ${index}`);
    }
    return outcome.result;
  });
}
