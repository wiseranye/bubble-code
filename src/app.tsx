import React from 'react';
import {Box, Text, useStdout} from 'ink';
import Input from './components/input.js';
import MessageList from './components/message-list.js';
import {useChat} from './use-chat.js';
import {Agent} from './agent/agent.js';

type Props = {
  readonly agent: Agent;
};

export default function App({agent}: Props) {
  const {messages, live, isStreaming, send, cancel} = useChat(agent);
  const {stdout} = useStdout();

  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;

  return (
    <Box flexDirection="column" width="100%">
      <MessageList
        messages={messages}
        live={live}
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
