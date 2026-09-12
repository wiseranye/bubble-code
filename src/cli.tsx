#!/usr/bin/env node
import process from 'node:process';
import React from 'react';
import {render} from 'ink';
import meow from 'meow';
import App from './app.js';

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

render(<App />);
