#!/usr/bin/env node
import process from 'node:process';
import { ProcessTerminal, TuiAltScreen } from '@earendil-works/pi-tui';
import meow from 'meow';
import { createAgentFactory } from './agent/agent-factory.ts';
import { AgentSession } from './agent/agent-session.ts';
import {
  type CompactConfig,
  DEFAULT_COMPACT_CONFIG,
} from './agent/compaction.ts';
import { initRuntime } from './agent/runtime.ts';
import { ModelCatalog } from './llm/model-catalog.ts';
import { SettingManager } from './setting-manager.ts';
import { newToolRegistry } from './tools/index.ts';
import { createChatApp } from './ui/app.ts';
import { setTerminalTitle } from './utils/shell.ts';

meow(
  `
	Usage
	  $ bubble

	Description
	  A coding agent for your terminal. Start a conversation and it will help
	  you read, write, and edit code.
`,
  {
    importMeta: import.meta,
  },
);

if (!process.stdin.isTTY) {
  process.stderr.write(
    'bubble-code needs an interactive terminal (TTY) to run.\n',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  setTerminalTitle('bubble');
  const runtime = initRuntime();
  const settings = await new SettingManager(runtime).load();
  // 可选模型目录：/model 的切换目标，选中项是 app 级状态，新会话跟随
  const catalog = new ModelCatalog(settings);
  // 工具注册中心同时给 Agent 和 UI 用：UI 靠它拿到每个工具的渲染器
  const tools = newToolRegistry();
  // 每个会话一个 Agent：协议历史随会话走，/new 和 /resume 都不会串上下文。
  // 没配模型不拦启动；首次发消息时由 Agent 提示
  const createAgent = createAgentFactory({
    tools,
    discoveryOptions: {
      cwd: runtime.cwd(),
      bubbleHome: runtime.homeDir(),
    },
    createModelApi: () => {
      const current = catalog.current;
      return current === undefined ? undefined : catalog.createApi(current);
    },
  });
  // 压缩配置按当前选中项现算：/model 切换后 /new 的会话跟随新模型的 contextWindow；
  // contextWindow 取装配后模型的生效值（settings 覆盖 catalog，兜底 256k）
  const createCompactConfig = (): CompactConfig => {
    const current = catalog.current;
    return {
      contextWindow:
        current === undefined
          ? DEFAULT_COMPACT_CONFIG.contextWindow
          : catalog.contextWindow(current),
      threshold: settings.compactThreshold,
      retainRatio: settings.compactRetainRatio,
    };
  };
  const terminal = new ProcessTerminal();
  // 全屏（备用屏）模式：转录区由视口自己滚动，工具消息的头部才能点开。
  // 鼠标是滚轮滚动和点击的前提，pi 默认开启，这里显式写出来
  const tui = new TuiAltScreen(terminal, undefined, undefined, { mouse: true });
  createChatApp(
    tui,
    sessionFile =>
      new AgentSession(createAgent(), sessionFile, createCompactConfig()),
    tools,
    catalog,
    settings.statusBar,
  );
  tui.start();
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
