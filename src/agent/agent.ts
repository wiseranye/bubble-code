// 有状态门面

import type { ModelApi } from '../llm/types.ts';
import type { ToolRegistry } from '../tools/types.ts';
import { runAgentLoop } from './agent-loop.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import type { AgentContext, AgentEvent, AgentState } from './types.ts';

export interface AgentOptions {
  modelApi?: ModelApi;
  tools: ToolRegistry;
}

export class Agent {
  private readonly _state: AgentState;
  private readonly _tools: ToolRegistry;

  private readonly _listeners = new Set<
    (event: AgentEvent, signal?: AbortSignal) => Promise<void> | void
  >();

  constructor({ modelApi, tools }: AgentOptions) {
    this._tools = tools;
    this._state = {
      messages: [],
      modelApi: modelApi,
    };
    this._state.messages.push({
      role: 'system',
      content: buildSystemPrompt(tools),
    });
  }

  subscribe(
    listener: (event: AgentEvent, signal?: AbortSignal) => Promise<void> | void,
  ): () => void {
    this._listeners.add(listener);
    // 取消订阅
    return () => this._listeners.delete(listener);
  }

  get state(): AgentState {
    return this._state;
  }

  async prompt(
    input: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this._state.modelApi) {
      // 配置问题不是生成失败，直接抛出，不走 run_end 事件
      throw new Error(
        '未配置模型，请先在 settings.jsonc 的 providers 中配置模型',
      );
    }
    const context: AgentContext = {
      tools: this._tools,
      messages: this._state.messages,
    };
    const newMessages = await runAgentLoop(
      input,
      context,
      async event => this._onEvent(event, signal),
      this._state.modelApi,
      signal,
    );

    this._state.messages.push(...newMessages);
  }

  private async _onEvent(
    event: AgentEvent,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const listener of this._listeners) {
      // eslint-disable-next-line no-await-in-loop -- 监听器按订阅顺序逐个通知
      await listener(event, signal);
    }
  }
}
