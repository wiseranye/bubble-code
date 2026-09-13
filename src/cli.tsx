#!/usr/bin/env node
import process from 'node:process';
import React from 'react';
import {render} from 'ink';
import meow from 'meow';
import App from './app.js';
import {OpenAiModel} from './model/openai.js';
import {loadSettings, ModelDef, Provider, Settings} from './settings.js';
import {Agent} from './agent/agent.js';
import {newToolRegistry} from './tools/index.js';

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
          provider: provider,
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
  // build agent
  const agent = new Agent({
    model: new OpenAiModel(provider.baseUrl, provider.apiKey, model.id),
    tools: newToolRegistry(),
  });
  render(<App agent={agent} />);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
