#!/usr/bin/env node
import process from 'node:process';
import {ProcessTerminal, TuiMainScreen} from '@earendil-works/pi-tui';
import meow from 'meow';
import {ChatSession} from './chat-session.js';
import {OpenAiModel} from './model/openai.js';
import {
  loadSettings,
  type ModelDef,
  type Provider,
  type Settings,
} from './settings.js';
import {Agent} from './agent/agent.js';
import {newToolRegistry} from './tools/index.js';
import {createChatApp} from './ui/app.js';
import {killTrackedChildren} from './utils/shell.js';

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

// 兜底：信号直接终止进程时不会触发 'exit' 事件，
// 这里先同步杀掉还在执行的 bash 子进程再退出。
// （TUI 原始模式下 Ctrl+C 走按键分支，不会到这里）
for (const [sig, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.on(sig, () => {
    killTrackedChildren();
    process.exit(exitCode);
  });
}

function findModel(settings: Settings): {provider: Provider; model: ModelDef} {
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
  const settings = await loadSettings();
  const {provider, model} = findModel(settings);
  // Build agent
  const agent = new Agent({
    model: new OpenAiModel(provider.baseUrl, provider.apiKey, model.id),
    tools: newToolRegistry(),
  });
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  // 目前只是单会话
  const session = new ChatSession(agent);
  createChatApp(tui, session);
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
