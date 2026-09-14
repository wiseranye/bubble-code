// 有状态门面

import {type Model} from '@bubble-code/model/llm.js';
import {type Message} from '@bubble-code/model/message.js';
import {type ToolRegistry} from '@bubble-code/tools/tool.js';
import {runAgentLoop} from './agent-loop.js';
import {type AgentEvent} from './events.js';
import {systemPrompt} from './constants.js';

export type AgentOptions = {
  model: Model;
  tools: ToolRegistry;
};

export class Agent {
  private readonly model: Model;
  private readonly tools: ToolRegistry;
  private readonly messages: Message[] = [];

  // 所有的监听器
  private readonly listeners: Set<(event: AgentEvent, signal?: AbortSignal) => Promise<void> | void> = new Set();

  constructor({model, tools}: AgentOptions) {
    this.model = model;
    this.tools = tools;
    this.messages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  /**
   * 订阅 Agent 生命周期事件
   */
  subscribe(listener: (event: AgentEvent, signal?: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(
    input: string,
    {signal}: {signal?: AbortSignal} = {},
  ): Promise<void> {
    this.messages.push({
      role: 'user',
      content: input,
    });
    await runAgentLoop(this.messages,
      async (event) => {
        for (const listener of this.listeners) {
          await listener(event, signal);
        }
      },
      {
        model: this.model,
        tools: this.tools,
        signal,
      });
  }

}
