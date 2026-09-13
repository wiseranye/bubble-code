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

meow(
  `
	Usage
	  $ bubble-code

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
