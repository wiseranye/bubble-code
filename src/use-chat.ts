import {useCallback, useRef, useState} from 'react';
import {MockChatClient, type ChatClient, type ChatMessage} from './llm.js';
import {type Message} from './types.js';

const welcomeMessage: Message = {
	id: 0,
	role: 'system',
	content:
		'欢迎使用 bubble-code —— 一个编码智能体。输入你的需求，按 Enter 发送。',
};

type UseChatResult = {
	messages: Message[];
	isStreaming: boolean;
	send: (text: string) => void;
	cancel: () => void;
};

export function useChat(
	client: ChatClient = new MockChatClient(),
): UseChatResult {
	const [messages, setMessages] = useState<Message[]>([welcomeMessage]);
	const [isStreaming, setIsStreaming] = useState(false);

	const messageStore = useRef<Message[]>(messages);
	const chatClient = useRef<ChatClient>(client);
	const idCounter = useRef(1);
	const generating = useRef(false);
	const shouldAbort = useRef(false);

	const commit = useCallback((update: (previous: Message[]) => Message[]) => {
		const next = update(messageStore.current);
		messageStore.current = next;
		setMessages(next);
	}, []);

	const send = useCallback(
		(text: string) => {
			const content = text.trim();
			if (content === '' || generating.current) {
				return;
			}

			const userMessage: Message = {
				id: idCounter.current++,
				role: 'user',
				content,
			};
			const assistantMessage: Message = {
				id: idCounter.current++,
				role: 'assistant',
				content: '',
			};
			const assistantId = assistantMessage.id;

			const history: ChatMessage[] = [];
			for (const message of messageStore.current) {
				if (message.role !== 'system') {
					history.push({role: message.role, content: message.content});
				}
			}

			history.push({role: 'user', content});

			commit(previous => [...previous, userMessage, assistantMessage]);

			generating.current = true;
			shouldAbort.current = false;
			setIsStreaming(true);

			void (async () => {
				try {
					for await (const event of chatClient.current.stream(history)) {
						if (shouldAbort.current) {
							break;
						}

						if (event.type === 'text') {
							commit(previous =>
								previous.map(message =>
									message.id === assistantId
										? {...message, content: message.content + event.text}
										: message,
								),
							);
						}
					}
				} catch (error: unknown) {
					const detail = error instanceof Error ? error.message : String(error);
					commit(previous =>
						previous.map(message =>
							message.id === assistantId
								? {
										...message,
										content: `${message.content}\n\n[生成出错] ${detail}`,
								  }
								: message,
						),
					);
				} finally {
					generating.current = false;
					setIsStreaming(false);
				}
			})();
		},
		[commit],
	);

	const cancel = useCallback(() => {
		if (generating.current) {
			shouldAbort.current = true;
		}
	}, []);

	return {messages, isStreaming, send, cancel};
}
