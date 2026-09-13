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

  constructor({model, tools}: AgentOptions) {
    this.model = model;
    this.tools = tools;
    this.messages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  async *send(
    input: string,
    {signal}: {signal?: AbortSignal} = {},
  ): AsyncGenerator<AgentEvent> {
    this.messages.push({
      role: 'user',
      content: input,
    });
    yield* runAgentLoop(this.messages, {
      model: this.model,
      tools: this.tools,
      signal,
    });
  }
}
