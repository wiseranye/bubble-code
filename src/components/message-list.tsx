import React, {useEffect, useMemo, useState} from 'react';
import {Box, Static, Text} from 'ink';
import cliTruncate from 'cli-truncate';
import {type ChatMessage, type ToolChatMessage} from '../use-chat.js';
import {stringWidth, tailRows, wrappedHeight} from '../utils/width.js';
import {
  clipLines,
  markdownHeight,
  renderMarkdown,
  stripAnsi,
  type CodeLine,
  type Span,
} from '../markdown/render.js';
import {peekRendered, renderHighlighted} from '../markdown/pipeline.js';

type Props = {
  // 已定稿的消息：写进终端 scrollback
  readonly messages: ChatMessage[];
  // 进行中的消息：每帧重绘
  readonly live: ChatMessage[];
  readonly isStreaming: boolean;
  readonly cols: number;
  readonly rows: number;
};

// 底部固定占用的行数：输入框 1 行 + 提示行最多 2 行 + 生成状态行 2 行，
// 再留 1 行余量。Ink 在帧高 >= 终端行数时会清屏重写（画面重复），
// 所以实时区域必须严格矮于终端
const reservedRows = 6;

// 工具输出超过这个行数就折叠，避免一条命令刷满整个消息区
const maxToolOutputLines = 8;

// 消息左侧标记列（标记 + 空格）占的列数
const markerColumns = 2;

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
        {message => (
          <MessageRow
            key={message.id}
            message={message}
            columns={cols}
            maxRows={undefined}
          />
        )}
      </Static>

      {visibleLive.map((entry, index) => (
        <MessageRow
          key={entry.message.id}
          message={entry.message}
          columns={cols}
          maxRows={entry.maxRows}
          isThinking={
            isStreaming &&
            index === visibleLive.length - 1 &&
            entry.message.role === 'assistant' &&
            entry.message.content === ''
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
  readonly columns: number;
  // 只显示末尾这么多行（实时区域放不下时由 selectVisible 给出）
  readonly maxRows: number | undefined;
  readonly isThinking?: boolean;
};

function MessageRow({message, columns, maxRows, isThinking = false}: RowProps) {
  const width = Math.max(1, columns - markerColumns);

  if (message.role === 'system') {
    return (
      <Box marginBottom={1}>
        <Text color="gray">{message.content}</Text>
      </Box>
    );
  }

  if (message.role === 'tool') {
    return <ToolRow message={message} columns={columns} maxRows={maxRows} />;
  }

  const isUser = message.role === 'user';
  const marker = isUser ? '❯' : '✦';
  const color = isUser ? 'cyan' : 'green';

  if (isThinking) {
    return (
      <Box marginBottom={1}>
        <Marker marker={marker} color={color} />
        <Text color="yellow">正在生成…</Text>
      </Box>
    );
  }

  return (
    <Box marginBottom={1}>
      <Marker marker={marker} color={color} />
      {isUser ? (
        <TextBody content={message.content} width={width} maxRows={maxRows} />
      ) : (
        <MarkdownText
          content={message.content}
          width={width}
          maxRows={maxRows}
        />
      )}
    </Box>
  );
}

type TextBodyProps = {
  readonly content: string;
  readonly width: number;
  readonly maxRows: number | undefined;
};

// 普通文本消息（用户输入）：和 markdown 一样，放不下时只显示末尾
function TextBody({content, width, maxRows}: TextBodyProps) {
  if (maxRows === undefined || wrappedHeight(content, width) <= maxRows) {
    return <Text>{content}</Text>;
  }

  const bodyRows = maxRows - 1;
  return (
    <Box flexDirection="column">
      <CutOffHint />
      {bodyRows > 0 ? <Text>{tailRows(content, width, bodyRows)}</Text> : null}
    </Box>
  );
}

function CutOffHint() {
  return <Text dimColor>… 以上内容已滚出屏幕</Text>;
}

type MarkerProps = {
  readonly marker: string;
  readonly color: string;
};

// 标记列固定宽度。Ink 里 Text 默认 flexShrink=1，内容超宽时瑜伽会把
// 1 列宽的标记也按比例压成 0 列，标记就消失了
function Marker({marker, color}: MarkerProps) {
  return (
    <Box flexShrink={0}>
      <Text bold color={color}>
        {marker}
      </Text>
      <Text> </Text>
    </Box>
  );
}

type MarkdownProps = {
  readonly content: string;
  readonly width: number;
  readonly maxRows: number | undefined;
};

// 内容每帧都在变，等稳定一下再算高亮，避免流式期间反复跑 shiki
const highlightDelay = 120;

// 助手消息按 markdown 渲染：先同步出纯文本，高亮（marked-shiki）算完后
// 从缓存换成带颜色的版本
function MarkdownText({content, width, maxRows}: MarkdownProps) {
  const plain = useMemo(
    () => renderMarkdown(content, {cols: width}),
    [content, width],
  );
  const [, setVersion] = useState(0);

  // 定稿前 settle 过的内容已经在缓存里，首帧就能直接渲染彩色版本
  const highlighted = peekRendered(content, width);
  const lines = clipLines(highlighted ?? plain, width, maxRows);

  useEffect(() => {
    if (peekRendered(content, width) !== undefined) {
      return;
    }

    let active = true;
    const timer = setTimeout(() => {
      void renderHighlighted(content, {cols: width})
        .catch(() => undefined)
        .then(() => {
          if (active) {
            setVersion(version => version + 1);
          }
        });
    }, highlightDelay);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [content, width]);

  return (
    <Box flexDirection="column">
      {lines.length === 0 ? <Text> </Text> : null}
      {lines.map((line, index) =>
        line.kind === 'code' ? (
          // 行只按位置渲染，没有稳定的 key
          // eslint-disable-next-line react/no-array-index-key
          <CodeLines key={index} line={line} width={width} />
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <Text key={index}>
            {line.spans.length === 0
              ? ' '
              : line.spans.map((span, spanIndex) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <SpanText key={spanIndex} span={span} />
                ))}
          </Text>
        ),
      )}
    </Box>
  );
}

type CodeLinesProps = {
  readonly line: CodeLine;
  readonly width: number;
};

function CodeLines({line, width}: CodeLinesProps) {
  const rendered = line.ansi ?? line.plain;
  // 自己按可用宽度截断：行内容比容器宽时，Ink 的布局不会把标记列让出来，
  // 只靠 wrap="truncate" 会多出几列
  const textWidth = Math.max(1, width - stringWidth(stripAnsi(line.prefix)));

  return (
    <Box flexDirection="column">
      {rendered.map((text, index) => (
        // 代码行不换行，超宽截断，否则会破坏缩进和行数
        // eslint-disable-next-line react/no-array-index-key
        <Text key={index} wrap="truncate">
          {line.prefix + cliTruncate(text === '' ? ' ' : text, textWidth)}
        </Text>
      ))}
    </Box>
  );
}

type SpanProps = {
  readonly span: Span;
};

function SpanText({span}: SpanProps) {
  return (
    <Text
      bold={span.bold}
      italic={span.italic}
      dimColor={span.dim}
      underline={span.underline}
      strikethrough={span.strikethrough}
      color={span.color}
      backgroundColor={span.backgroundColor}
    >
      {span.text}
    </Text>
  );
}

type ToolRowProps = {
  readonly message: ToolChatMessage;
  readonly columns: number;
  readonly maxRows: number | undefined;
};

function ToolRow({message, columns, maxRows}: ToolRowProps) {
  const running = message.status === 'running';
  const failed = !running && !message.success;

  // 执行中 → 黄色齿轮；失败 → 红色叉；成功 → 黄色齿轮
  const marker = failed ? '✗' : '⚙';
  const color = failed ? 'red' : 'yellow';

  const input = summariseInput(message.input);
  const textWidth = Math.max(1, columns - markerColumns);
  // 固定占用的行：头部一行 + 参数行 + 「还有 N 行」提示行
  const fixedRows =
    1 + (input === '' ? 0 : wrappedHeight(input, textWidth)) + 1;
  const limit =
    maxRows === undefined
      ? maxToolOutputLines
      : Math.max(0, Math.min(maxToolOutputLines, maxRows - fixedRows));
  const {lines, hidden} = toolOutputLines(message.output, limit);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Marker marker={marker} color={color} />
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

function toolOutputLines(output: string, limit: number): OutputLines {
  if (output === '' || limit <= 0) {
    return {lines: [], hidden: 0};
  }

  const all = output.replace(/\n+$/, '').split('\n');
  return {
    lines: all.slice(0, limit),
    hidden: Math.max(0, all.length - limit),
  };
}

type VisibleMessage = {
  message: ChatMessage;
  // 只渲染末尾这么多行；undefined 表示整条显示
  maxRows: number | undefined;
};

// 从最新往回挑能放进屏幕的消息。实时区域必须始终矮于终端：
// 一旦超过，Ink 会清屏重写（表现为画面重复）
function selectVisible(
  messages: ChatMessage[],
  availableRows: number,
  columns: number,
): VisibleMessage[] {
  const visible: VisibleMessage[] = [];
  let usedRows = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }

    const budget = availableRows - usedRows;
    if (budget <= 0) {
      break;
    }

    const height = messageHeight(message, columns);
    if (height <= budget) {
      visible.unshift({message, maxRows: undefined});
      usedRows += height;
      continue;
    }

    // 只有最新的一条裁掉头部（留一行给省略提示）；更早的整条丢弃，免得全是碎片
    if (visible.length === 0) {
      visible.unshift({message, maxRows: Math.max(1, budget - 1)});
      usedRows = availableRows;
    }

    break;
  }

  return visible;
}

function messageHeight(message: ChatMessage, columns: number): number {
  if (message.role === 'tool') {
    return toolHeight(message, columns) + 1;
  }

  const prefixWidth = message.role === 'system' ? 0 : markerColumns;
  const textWidth = Math.max(1, columns - prefixWidth);

  if (message.role === 'assistant' && message.content !== '') {
    return markdownHeight(message.content, textWidth) + 1;
  }

  const content = message.content === '' ? '正在生成…' : message.content;
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

  const {lines, hidden} = toolOutputLines(message.output, maxToolOutputLines);
  for (const line of lines) {
    height += wrappedHeight(line === '' ? ' ' : line, textWidth);
  }

  if (hidden > 0) {
    height += 1;
  }

  return height;
}
