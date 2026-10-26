// 有状态门面

import type { ModelApi, UserMessage } from '../llm/types.ts';
import type { ToolRegistry } from '../tools/types.ts';
import {
  type AgentLoopHook,
  fireAgentLoopHooks,
  runAgentLoop,
  stateHookContext,
} from './agent-loop.ts';
import { formatAvailableSkills, type SkillSnapshot } from './skills.ts';
import { SystemPromptAssembler } from './system-prompt.ts';
import type { AgentContext, AgentEvent, AgentState } from './types.ts';

export interface AgentOptions {
  modelApi?: ModelApi;
  tools: ToolRegistry;
  skillSnapshot?: SkillSnapshot;
}

// 未配置模型时的提示：Agent.prompt 抛出，AgentSession 在落盘与触发钩子之前先做同样检查
export const UNCONFIGURED_MODEL_MESSAGE =
  '未配置模型，请先在 settings.jsonc 的 providers 中配置模型';

// 有状态门面。刷新与压缩等内置钩子由 AgentSession 注册：
// 脱离 AgentSession 单独使用 Agent 时不会产出系统提示词
export class Agent {
  private readonly _state: AgentState;
  private readonly _tools: ToolRegistry;
  private readonly _hooks: AgentLoopHook[] = [];
  // 系统提示词装配器：生命周期与 Agent 一致，construction 节只求值一次。
  // 系统消息不随构造写入历史：每次 run / 请求前由刷新钩子按需追加，
  // 恢复的老会话也能借此感知工具与扩展的变化
  readonly systemPrompt: SystemPromptAssembler;
  readonly skillSnapshot: SkillSnapshot;

  private readonly _listeners = new Set<
    (event: AgentEvent, signal?: AbortSignal) => Promise<void> | void
  >();

  constructor({
    modelApi,
    tools,
    skillSnapshot = { skills: [], warnings: [] },
  }: AgentOptions) {
    this._tools = tools;
    this.skillSnapshot = skillSnapshot;
    this._state = {
      messages: [],
      modelApi: modelApi,
    };
    this.systemPrompt = new SystemPromptAssembler(
      {
        tools,
        cwd: process.cwd(),
      },
      [
        {
          name: 'skills',
          freshness: 'construction',
          build: () => formatAvailableSkills(skillSnapshot.skills),
        },
      ],
    );
  }

  subscribe(
    listener: (event: AgentEvent, signal?: AbortSignal) => Promise<void> | void,
  ): () => void {
    this._listeners.add(listener);
    // 取消订阅
    return () => this._listeners.delete(listener);
  }

  // 同一时机的钩子按注册顺序串行执行
  registerHook(hook: AgentLoopHook): void {
    this._hooks.push(hook);
  }

  // 每次 run 开始、用户消息进入历史与落盘之前触发：
  // 钩子里追加的系统消息在生产顺序上排在本次用户消息之前
  async prepareRun(signal?: AbortSignal): Promise<void> {
    await fireAgentLoopHooks(
      this._hooks,
      'prepareRun',
      stateHookContext(this._state.messages, signal),
    );
  }

  get state(): AgentState {
    return this._state;
  }

  async prompt(
    input: UserMessage,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this._state.modelApi) {
      // 配置问题不是生成失败，直接抛出，不走 run_end 事件
      throw new Error(UNCONFIGURED_MODEL_MESSAGE);
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
      { hooks: this._hooks },
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
