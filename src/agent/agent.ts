// 有状态门面

import { type Model } from '@bubble-code/model/llm.js';
import { type ToolRegistry } from '@bubble-code/tools/tool.js';
import { runAgentLoop } from './agent-loop.js';
import type { AgentContext, AgentMessage, AgentEvent } from './types.js';
import { systemPrompt } from './constants.js';

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
      event => this.onEvent(event, signal),
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
      await listener(event, signal);
    }
  }
}
