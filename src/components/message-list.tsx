import React, {useEffect, useState} from 'react';
import {Box, Static, Text} from 'ink';
import {type ChatMessage, type ToolChatMessage} from '../use-chat.js';
import {stringWidth} from '../utils/width.js';

type Props = {
  // 已定稿的消息：写进终端 scrollback
  readonly messages: ChatMessage[];
  // 进行中的消息：每帧重绘
  readonly live: ChatMessage[];
  readonly isStreaming: boolean;
  readonly cols: number;
  readonly rows: number;
};

// 输入框、提示行和生成状态行占掉的底部行数
const reservedRows = 5;

// 工具输出超过这个行数就折叠，避免一条命令刷满整个消息区
const maxToolOutputLines = 8;

export default function MessageList({
  messages,
  live,
  isStreaming,
  cols,
  rows,
}: Props) {
  const availableRows = Math.max(1, rows - reservedRows);
  const visibleLive = selectVisible(live, availableRows, cols);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/*
				定稿的消息交给 <Static>：只写一次，直接进终端 scrollback，
				不参与每帧重绘，所以多少条都不会丢
			*/}
      <Static items={messages}>
        {message => <MessageRow key={message.id} message={message} />}
      </Static>

      {visibleLive.map((message, index) => (
        <MessageRow
          key={message.id}
          message={message}
          isThinking={
            isStreaming &&
            index === visibleLive.length - 1 &&
            message.role === 'assistant' &&
            message.content === ''
          }
        />
      ))}

      {isStreaming ? <BubblingIndicator /> : null}
    </Box>
  );
}

// 生成中的状态行：一个小气泡鼓起来再缩回去的动画
const bubbleFrames = ['·', '∘', '○', '∘'];
const bubbleInterval = 160;

function BubblingIndicator() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(current => (current + 1) % bubbleFrames.length);
    }, bubbleInterval);

    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <Box marginBottom={1}>
      <Text bold color="yellow">
        {bubbleFrames[frame] ?? '○'}
      </Text>
      <Text color="yellow"> Bubbling ...</Text>
    </Box>
  );
}

type RowProps = {
  readonly message: ChatMessage;
  readonly isThinking?: boolean;
};

function MessageRow({message, isThinking = false}: RowProps) {
  if (message.role === 'system') {
    return (
      <Box marginBottom={1}>
        <Text color="gray">{message.content}</Text>
      </Box>
    );
  }

  if (message.role === 'tool') {
    return <ToolRow message={message} />;
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

type ToolRowProps = {
  readonly message: ToolChatMessage;
};

function ToolRow({message}: ToolRowProps) {
  const running = message.status === 'running';
  const failed = !running && !message.success;

  // 执行中 → 黄色齿轮；失败 → 红色叉；成功 → 黄色齿轮
  const marker = failed ? '✗' : '⚙';
  const color = failed ? 'red' : 'yellow';

  const input = summariseInput(message.input);
  const {lines, hidden} = toolOutputLines(message.output);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={color}>
          {marker}
        </Text>
        <Text> </Text>
        <Text bold color={color}>
          {message.name}
        </Text>
        {running ? <Text color="yellow">（执行中…）</Text> : null}
      </Box>

      {input === '' ? null : (
        <Box paddingLeft={2}>
          <Text dimColor>→ {input}</Text>
        </Box>
      )}

      {lines.map((line, index) => (
        // 输出行只按位置渲染，没有稳定的 key
        // eslint-disable-next-line react/no-array-index-key
        <Box key={index} paddingLeft={2}>
          <Text dimColor>{line === '' ? ' ' : line}</Text>
        </Box>
      ))}

      {hidden > 0 ? (
        <Box paddingLeft={2}>
          <Text dimColor>… 还有 {hidden} 行输出</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// 参数压成一行展示：只有一个字段（比如 bash 的 command）时只显示值，
// 其余情况原样显示 JSON
function summariseInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    return '';
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const entries = Object.entries(parsed);
      const single = entries.length === 1 ? entries[0] : undefined;
      if (single) {
        const [, value] = single;
        if (typeof value === 'string') {
          return toSingleLine(value);
        }
      }
    }
  } catch {
    // 参数不是合法 JSON，原样显示
  }

  return toSingleLine(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 多行参数（比如写文件的 content）只显示第一行，避免撑爆消息区
function toSingleLine(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  return rest.length > 0 ? `${first} …` : first;
}

type OutputLines = {
  lines: string[];
  hidden: number;
};

function toolOutputLines(output: string): OutputLines {
  if (output === '') {
    return {lines: [], hidden: 0};
  }

  const all = output.replace(/\n+$/, '').split('\n');
  return {
    lines: all.slice(0, maxToolOutputLines),
    hidden: Math.max(0, all.length - maxToolOutputLines),
  };
}

function selectVisible(
  messages: ChatMessage[],
  availableRows: number,
  columns: number,
): ChatMessage[] {
  const visible: ChatMessage[] = [];
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

function messageHeight(message: ChatMessage, columns: number): number {
  if (message.role === 'tool') {
    return toolHeight(message, columns) + 1;
  }

  const prefixWidth = message.role === 'system' ? 0 : 2;
  const content = message.content === '' ? '正在生成…' : message.content;
  const textWidth = Math.max(1, columns - prefixWidth);

  return wrappedHeight(content, textWidth) + 1;
}

function toolHeight(message: ToolChatMessage, columns: number): number {
  // 头部（marker + 名字）固定 1 行
  let height = 1;
  const textWidth = Math.max(1, columns - 2);

  const input = summariseInput(message.input);
  if (input !== '') {
    height += wrappedHeight(input, textWidth);
  }

  const {lines, hidden} = toolOutputLines(message.output);
  for (const line of lines) {
    height += wrappedHeight(line === '' ? ' ' : line, textWidth);
  }

  if (hidden > 0) {
    height += 1;
  }

  return height;
}

// 一段文本按终端宽度占多少行（含自动换行）
function wrappedHeight(text: string, width: number): number {
  let lines = 0;
  for (const line of text.split('\n')) {
    lines += Math.max(1, Math.ceil(stringWidth(line) / width));
  }

  return lines;
}
