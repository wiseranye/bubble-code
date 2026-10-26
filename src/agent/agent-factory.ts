import type { ModelApi } from '../llm/types.ts';
import type { ToolRegistry } from '../tools/types.ts';
import { Agent } from './agent.ts';
import { type DiscoverSkillsOptions, discoverSkills } from './skills.ts';

export interface AgentFactoryOptions {
  readonly tools: ToolRegistry;
  readonly createModelApi: () => ModelApi | undefined;
  readonly discoveryOptions: DiscoverSkillsOptions;
  // 测试可注入 spy；生产始终使用真实发现函数。
  readonly discover?: typeof discoverSkills;
}

// 每次调用工厂都对应一个新 Agent/会话，因此只在这里扫描一次 Skill 目录。
// Agent 后续的 run/turn 只使用传入的不可变目录快照。
export function createAgentFactory(options: AgentFactoryOptions): () => Agent {
  const discover = options.discover ?? discoverSkills;
  return () => {
    const skillSnapshot = discover(options.discoveryOptions);
    return new Agent({
      modelApi: options.createModelApi(),
      tools: options.tools,
      skillSnapshot,
    });
  };
}
