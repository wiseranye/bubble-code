import React from 'react';
import {Box, Text} from 'ink';
import {type Message} from '../types.js';
import {stringWidth} from '../utils/width.js';

type Props = {
	readonly messages: Message[];
	readonly isStreaming: boolean;
	readonly cols: number;
	readonly rows: number;
};

// Header, input and hint lines are kept out of the message area.
const reservedRows = 5;

export default function MessageList({
	messages,
	isStreaming: isStreaming,
	cols: cols,
	rows,
}: Props) {
	const availableRows = Math.max(1, rows - reservedRows);
	const visible = selectVisible(messages, availableRows, cols);

	return (
		<Box flexDirection="column" flexGrow={1}>
			{visible.map((message, index) => {
				const isLast = index === visible.length - 1;
				const isThinking =
					isStreaming &&
					isLast &&
					message.role === 'assistant' &&
					message.content === '';

				return (
					<MessageRow
						key={message.id}
						isThinking={isThinking}
						message={message}
					/>
				);
			})}
		</Box>
	);
}

type RowProps = {
	readonly message: Message;
	readonly isThinking: boolean;
};

function MessageRow({message, isThinking}: RowProps) {
	if (message.role === 'system') {
		return (
			<Box marginBottom={1}>
				<Text color="gray">{message.content}</Text>
			</Box>
		);
	}

	const isUser = message.role === 'user';
	const marker = isUser ? '❯' : '✦';
	const color = isUser ? 'cyan' : 'green';

	if (isThinking) {
		return (
			<Box marginBottom={1}>
				<Text bold color={color}>
					{marker}
				</Text>
				<Text> </Text>
				<Text color="yellow">正在生成…</Text>
			</Box>
		);
	}

	return (
		<Box marginBottom={1}>
			<Text bold color={color}>
				{marker}
			</Text>
			<Text> </Text>
			<Text>{message.content}</Text>
		</Box>
	);
}

function selectVisible(
	messages: Message[],
	availableRows: number,
	columns: number,
): Message[] {
	const visible: Message[] = [];
	let usedRows = 0;

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === undefined) {
			continue;
		}

		const height = messageHeight(message, columns);
		if (usedRows + height > availableRows && visible.length > 0) {
			break;
		}

		visible.unshift(message);
		usedRows += height;
	}

	return visible;
}

function messageHeight(message: Message, columns: number): number {
	const prefixWidth = message.role === 'system' ? 0 : 2;
	const content = message.content === '' ? '正在生成…' : message.content;
	const textWidth = Math.max(1, columns - prefixWidth);

	let lines = 0;
	for (const line of content.split('\n')) {
		lines += Math.max(1, Math.ceil(stringWidth(line) / textWidth));
	}

	return lines + 1;
}
