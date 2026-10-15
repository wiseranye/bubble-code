#!/usr/bin/env node
import process from 'node:process';
import { ProcessTerminal, TuiAltScreen } from '@earendil-works/pi-tui';
import meow from 'meow';
import { Agent } from './agent/agent.ts';
import { AgentSession } from './agent/agent-session.ts';
import { OpenAiModel } from './llm/api/openai-completions.ts';
import {
  loadSettings,
  type ModelDef,
  type Provider,
  type Settings,
} from './settings.ts';
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

function findModel(settings: Settings): {
  provider: Provider;
  model: ModelDef;
} {
  for (const provider of settings.providers) {
    if (!provider.models) {
      continue;
    }

    for (const modelDef of provider.models) {
      if (modelDef) {
        return {
          provider,
          model: modelDef,
        };
      }
    }
  }

  throw new Error('no model available!');
}

async function main(): Promise<void> {
  setTerminalTitle('bubble');
  const settings = await loadSettings();
  const { provider, model } = findModel(settings);
  // 工具注册中心同时给 Agent 和 UI 用：UI 靠它拿到每个工具的渲染器
  const tools = newToolRegistry();
  // 每个会话一个 Agent：协议历史随会话走，/new 和 /resume 都不会串上下文
  const createAgent = (): Agent =>
    new Agent({
      model: new OpenAiModel(provider.baseUrl, provider.apiKey, model.id),
      tools,
    });
  const terminal = new ProcessTerminal();
  // 全屏（备用屏）模式：转录区由视口自己滚动，工具消息的头部才能点开。
  // 鼠标是滚轮滚动和点击的前提，pi 默认开启，这里显式写出来
  const tui = new TuiAltScreen(terminal, undefined, undefined, { mouse: true });
  createChatApp(
    tui,
    sessionFile => new AgentSession(createAgent(), sessionFile),
    tools,
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
