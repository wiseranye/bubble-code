import {useCallback, useRef, useState} from 'react';
import {useStdout} from 'ink';
import {type Agent} from './agent/agent.js';
import {settleMarkdown} from './markdown/pipeline.js';

// 文本消息（system / user / assistant）
export type TextChatMessage = {
  id: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
};

// 工具调用消息：一次调用一条，结果回来后在原地更新
export type ToolChatMessage = {
  id: number;
  role: 'tool';
  toolCallId: string;
  name: string;
  // 模型给出的原始参数（JSON 字符串）
  input: string;
  // 执行结果，未完成时为空串
  output: string;
  status: 'running' | 'done';
  success: boolean;
};

export type ChatMessage = TextChatMessage | ToolChatMessage;

const welcomeMessage: TextChatMessage = {
  id: 0,
  role: 'system',
  content: 'bubble-code · 编码智能体\n输入你的需求，按 Enter 发送。',
};

type UseChatResult = {
  // 已结束的消息：只增不改，交给 <Static> 写进终端 scrollback
  messages: ChatMessage[];
  // 还在流式接收 / 执行中的消息：每帧重绘
  live: ChatMessage[];
  isStreaming: boolean;
  send: (text: string) => void;
  cancel: () => void;
};

export function useChat(agent: Agent): UseChatResult {
  const {stdout} = useStdout();
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage]);
  // messages 是「已定稿前缀 + 进行中后缀」，这个数字是两者的分界
  const [finalizedCount, setFinalizedCount] = useState(1);
  const [isStreaming, setIsStreaming] = useState(false);

  const messageStore = useRef<ChatMessage[]>(messages);
  const idCounter = useRef(1);
  const generating = useRef(false);
  const abortController = useRef<AbortController | undefined>(undefined);
  // 当前正在流式接收的 assistant 气泡；遇到工具调用就置空，之后的文本另起一段
  const assistantBlock = useRef<number | undefined>(undefined);
  // tool_call_id → UI 消息 id，用来把 tool_result 贴回对应的工具消息
  const toolBlocks = useRef(new Map<string, number>());

  const commit = useCallback(
    (update: (previous: ChatMessage[]) => ChatMessage[]) => {
      const next = update(messageStore.current);
      messageStore.current = next;
      setMessages(next);
    },
    [],
  );

  // 把前 count 条标记为已定稿（只前进）：定稿之后不会再被修改，
  // 可以安全交给 <Static> 写进 scrollback
  const finalize = useCallback((count: number) => {
    setFinalizedCount(previous => Math.max(previous, count));
  }, []);

  const patch = useCallback(
    (id: number, update: (message: ChatMessage) => ChatMessage) => {
      commit(previous =>
        previous.map(message =>
          message.id === id ? update(message) : message,
        ),
      );
    },
    [commit],
  );

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (content === '' || generating.current) {
        return;
      }

      const userMessage: TextChatMessage = {
        id: idCounter.current++,
        role: 'user',
        content,
      };

      commit(previous => [...previous, userMessage]);
      // 用户消息一提交就是终态
      finalize(messageStore.current.length);

      generating.current = true;
      assistantBlock.current = undefined;
      toolBlocks.current.clear();
      setIsStreaming(true);

      const controller = new AbortController();
      abortController.current = controller;

      // assistant 气泡按需创建：文本 → 工具 → 再文本，工具消息才能插在
      // 两段文本中间。若一开始就建好气泡，最终回答会渲染在工具调用上面。
      const appendAssistantText = (delta: string) => {
        let id = assistantBlock.current;
        if (id === undefined) {
          const message: TextChatMessage = {
            id: idCounter.current++,
            role: 'assistant',
            content: '',
          };
          id = message.id;
          assistantBlock.current = id;
          commit(previous => [...previous, message]);
        }

        patch(id, message =>
          message.role === 'tool'
            ? message
            : {...message, content: message.content + delta},
        );
      };

      // <Static> 写出去的内容不会再更新，所以定稿前必须把语法高亮算完
      const settleDraft = async (id: number | undefined) => {
        if (id === undefined) {
          return;
        }

        const draft = messageStore.current.find(message => message.id === id);
        if (draft === undefined || draft.role !== 'assistant') {
          return;
        }

        await settleMarkdown([draft.content], stdout.columns ?? 80);
      };

      void (async () => {
        try {
          for await (const event of agent.send(content, {
            signal: controller.signal,
          })) {
            switch (event.type) {
              case 'assistant_delta': {
                appendAssistantText(event.text);
                break;
              }
              case 'tool_start': {
                // 工具调用开始，说明上一段文本已经写完了，可以定稿
                const draft = assistantBlock.current;
                assistantBlock.current = undefined;
                await settleDraft(draft);
                finalize(messageStore.current.length);
                const message: ToolChatMessage = {
                  id: idCounter.current++,
                  role: 'tool',
                  toolCallId: event.tool_call_id,
                  name: event.name,
                  input: event.input,
                  output: '',
                  status: 'running',
                  success: true,
                };
                toolBlocks.current.set(event.tool_call_id, message.id);
                commit(previous => [...previous, message]);
                break;
              }
              case 'tool_result': {
                const id = toolBlocks.current.get(event.tool_call_id);
                if (id !== undefined) {
                  patch(id, message =>
                    message.role === 'tool'
                      ? {
                          ...message,
                          output: event.output,
                          success: event.success,
                          status: 'done',
                        }
                      : message,
                  );
                  // 结果已到，这条工具消息定稿
                  const index = messageStore.current.findIndex(
                    message => message.id === id,
                  );
                  if (index !== -1) {
                    finalize(index + 1);
                  }
                }
                break;
              }
              case 'error': {
                appendAssistantText(`\n\n[出错] ${event.error.message}`);
                break;
              }
              default: {
                break;
              }
            }
          }
        } catch (error: unknown) {
          // 用户主动取消时抛的是 AbortError，不当成错误显示
          if (!controller.signal.aborted) {
            const detail =
              error instanceof Error ? error.message : String(error);
            appendAssistantText(`\n\n[生成出错] ${detail}`);
          }
        } finally {
          const draft = assistantBlock.current;
          assistantBlock.current = undefined;
          // 取消或异常退出时，可能还有工具块停在「执行中」
          commit(previous =>
            previous.map(message =>
              message.role === 'tool' && message.status === 'running'
                ? {...message, status: 'done', success: false}
                : message,
            ),
          );
          generating.current = false;
          abortController.current = undefined;
          setIsStreaming(false);
          // 收尾：最后一段文本等语法高亮算完再定稿，没跑完的工具块一起定稿
          await settleDraft(draft);
          finalize(messageStore.current.length);
        }
      })();
    },
    [agent, commit, patch, stdout],
  );

  const cancel = useCallback(() => {
    abortController.current?.abort();
  }, []);

  const history = messages.slice(0, finalizedCount);
  const live = messages.slice(history.length);

  return {messages: history, live, isStreaming, send, cancel};
}
