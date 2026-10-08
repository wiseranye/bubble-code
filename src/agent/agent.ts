// 有状态门面

import type { AgentMessage, Model } from '../llm/types.ts';
import type { ToolRegistry } from '../tools/types.ts';
import { runAgentLoop } from './agent-loop.ts';
import { systemPrompt } from './constants.ts';
import type { AgentContext, AgentEvent } from './types.ts';

export type AgentOptions = {
  model: Model;
  tools: ToolRegistry;
};

export class Agent {
  private readonly model: Model;
  private readonly tools: ToolRegistry;
  private readonly messages: AgentMessage[] = [];

  private readonly listeners = new Set<
    (event: AgentEvent, signal?: AbortSignal) => Promise<void> | void
  >();

  constructor({ model, tools }: AgentOptions) {
    this.model = model;
    this.tools = tools;
    this.messages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  subscribe(
    listener: (event: AgentEvent, signal?: AbortSignal) => Promise<void> | void,
  ): () => void {
    this.listeners.add(listener);
    // 取消订阅
    return () => this.listeners.delete(listener);
  }

  async prompt(
    input: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const context: AgentContext = {
      tools: this.tools,
      messages: this.messages,
    };
    const newMessages = await runAgentLoop(
      input,
      context,
      async event => this.onEvent(event, signal),
      this.model,
      signal,
    );

    this.messages.push(...newMessages);
  }

  private async onEvent(
    event: AgentEvent,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const listener of this.listeners) {
      // eslint-disable-next-line no-await-in-loop -- 监听器按订阅顺序逐个通知
      await listener(event, signal);
    }
  }
}
