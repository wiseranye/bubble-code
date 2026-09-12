import React from 'react';
import {Box, Text, useStdout} from 'ink';
import Input from './components/input.js';
import MessageList from './components/message-list.js';
import {type ChatClient} from './llm.js';
import {useChat} from './use-chat.js';

type Props = {
	readonly client?: ChatClient;
};

export default function App({client}: Props) {
	const {messages, isStreaming, send, cancel} = useChat(client);
	const {stdout} = useStdout();

	const cols = stdout.columns ?? 80;
	const rows = stdout.rows ?? 24;

	return (
		<Box flexDirection="column" width="100%">
			<Box>
				<Text bold color="magenta">
					bubble-code
				</Text>
				<Text dimColor> · 编码智能体</Text>
				{isStreaming ? <Text color="yellow">（正在生成…）</Text> : null}
			</Box>

			<MessageList
				messages={messages}
				isStreaming={isStreaming}
				cols={cols}
				rows={rows}
			/>

			<Box>
				<Input isDisabled={isStreaming} onCancel={cancel} onSubmit={send} />
			</Box>

			<Box>
				<Text dimColor>
					Enter 发送 · Shift+Enter 换行 · ↑↓ 历史 · Ctrl+U 清空 · Esc 取消 ·
					Ctrl+C 退出
				</Text>
			</Box>
		</Box>
	);
}
