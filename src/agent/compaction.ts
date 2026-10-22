// 上下文压缩：用量测量、保留区间切点、摘要侧信道调用、恢复投影
// 术语见 CONTEXT.md（Compaction / Summary / Compaction entry / Retained tail）

import { calculateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { AgentMessage, Message, ModelApi } from '../llm/types.ts';
import type {
  SessionCompactionEntry,
  SessionEntry,
  SessionMessageEntry,
} from './session-manager.ts';

// 摘要消息在上下文里的固定前缀：压缩后摘要作为 user 消息紧跟 system prompt
export const SUMMARY_PREFIX = 'Previous conversation summary:\n\n';

export interface CompactConfig {
  contextWindow: number;
  // 占用超过 contextWindow × threshold 触发自动压缩
  threshold: number;
  // 保留区间的 token 预算占比
  retainRatio: number;
}

export const DEFAULT_COMPACT_CONFIG: CompactConfig = {
  contextWindow: 256_000,
  threshold: 0.8,
  retainRatio: 0.16,
};

// 摘要调用的收尾指令：作为侧信道的最后一条 user 消息
const SUMMARIZE_INSTRUCTION = `以上是本次编程会话中较早的对话记录。请将它们压缩成一份简洁的结构化摘要，供后续对话作为上下文使用。要求覆盖：
1. 用户的目标与需求
2. 已完成的操作与关键决策
3. 重要的文件路径、代码位置与技术细节
4. 尚未解决的问题与待办事项
直接输出摘要正文，不要输出其他内容。`;

const CHARS_PER_TOKEN = 4;

// 单条消息的字符量估计：只算模型可见的文本内容
export function estimateMessageChars(message: AgentMessage): number {
  switch (message.role) {
    case 'system':
    case 'user': {
      return message.content.length;
    }

    case 'assistant': {
      let chars = 0;
      for (const block of message.content) {
        if (block.type === 'text') {
          chars += block.text.length;
        } else if (block.type === 'thinking') {
          chars += block.thinking.length;
        } else {
          chars += block.name.length + safeJsonStringify(block.input).length;
        }
      }
      return chars;
    }

    case 'tool_result': {
      return message.output.length + (message.error?.length ?? 0);
    }
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

// 上下文 token 估计：锚定最近一条带 usage 的 assistant 消息（真实 API 计数），
// 其后的消息按 chars/4 估算增量；没有锚点时全部按估算
export function estimateContextTokens(
  messages: readonly AgentMessage[],
): number {
  let anchorIndex = -1;
  let anchorTokens = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.usage !== undefined) {
      anchorIndex = index;
      anchorTokens = calculateContextTokens(message.usage);
      break;
    }
  }

  let total = anchorTokens;
  for (let index = anchorIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message !== undefined) {
      total += Math.ceil(estimateMessageChars(message) / CHARS_PER_TOKEN);
    }
  }
  return total;
}

// 从尾部向前累积 chars/4，直到达到保留预算，得到保留区间的起始下标 k。
// minIndex 是可摘要区间的下界（system prompt 与旧摘要消息不参与）。
// 工具配对安全：k 不能落在 tool_result 上——它的 assistant 若被摘要，
// 保留区间里就是孤儿 tool_result，API 会 400；此时把 k 往前挪，扩大保留区间
export function findRetainedStart(
  messages: readonly AgentMessage[],
  retainBudgetTokens: number,
  minIndex: number,
): number {
  let accumulated = 0;
  let k = messages.length;
  for (let index = messages.length - 1; index >= minIndex; index--) {
    if (accumulated >= retainBudgetTokens) {
      break;
    }
    const message = messages[index];
    if (message !== undefined) {
      accumulated += estimateMessageChars(message) / CHARS_PER_TOKEN;
    }
    k = index;
  }

  while (k > minIndex && messages[k]?.role === 'tool_result') {
    k--;
  }
  return k;
}

// 生成投影里的摘要 user 消息
export function makeSummaryMessage(summary: string): AgentMessage {
  return {
    role: 'user',
    content: `${SUMMARY_PREFIX}${summary}`,
    timestamp: Date.now(),
  };
}

// 组装摘要侧信道消息：旧摘要（如有）+ 待摘要消息 + 收尾指令。
// 侧信道不持久化、不进会话历史，也不带 system prompt 和工具
export function buildSummarizationMessages(
  previousSummary: string | undefined,
  summarized: readonly AgentMessage[],
): Message[] {
  const messages: Message[] = [];
  if (previousSummary !== undefined) {
    messages.push({
      role: 'user',
      content: `以下是上一次压缩生成的摘要，请在其基础上合并新的对话内容：\n\n${previousSummary}`,
      timestamp: Date.now(),
    });
  }
  messages.push(...summarized);
  messages.push({
    role: 'user',
    content: SUMMARIZE_INSTRUCTION,
    timestamp: Date.now(),
  });
  return messages;
}

// 发起摘要调用并收集全文；流出错/取消时抛错，由调用方决定如何收场
export async function collectSummary(
  modelApi: ModelApi,
  messages: Message[],
  signal?: AbortSignal,
): Promise<string> {
  let text = '';
  for await (const event of modelApi.stream(messages, { signal })) {
    if (event.type === 'text_delta') {
      text += event.delta;
    } else if (event.type === 'error') {
      throw event.error;
    }
  }

  const summary = text.trim();
  if (summary === '') {
    throw new Error('模型没有返回摘要');
  }
  return summary;
}

// 转录区条目：会话文件里的消息与压缩标记按原始顺序重放
export type TranscriptItem =
  | { kind: 'message'; entry: SessionMessageEntry }
  | { kind: 'compaction'; entry: SessionCompactionEntry };

export interface ResumeProjection {
  // 上一次压缩的摘要；没有有效压缩条目时为 undefined
  summary: string | undefined;
  // 进入协议历史的消息条目（摘要消息由调用方补；文件中最后一条系统消息
  // 若被压缩切点排除在外，由本投影重新纳入，充当刷新基线）
  contextEntries: SessionMessageEntry[];
  // 转录区重建素材：全量消息 + 压缩标记，被摘要的消息在界面上仍然可见
  transcript: TranscriptItem[];
  // 最后一次压缩之后新增的消息数（手动压缩的「没有新消息」守卫用）
  messagesSinceCompaction: number;
}

// 恢复投影：以最后一条压缩条目为准，上下文 = 摘要 + 保留区间 + 压缩后新增的消息；
// 文件里最后一条系统消息不在其中时也补入（刷新基线）。
// firstRetainedEntryId 找不到（文件损坏）时忽略该压缩条目，保留全部消息
export function projectSessionEntries(
  entries: readonly SessionEntry[],
): ResumeProjection {
  const transcript: TranscriptItem[] = [];
  // 消息条目连同它在文件里的位置：压缩条目按位置切分段落
  const positioned: Array<{ entry: SessionMessageEntry; position: number }> =
    [];
  const compactions: Array<{
    entry: SessionCompactionEntry;
    position: number;
  }> = [];
  for (const [position, entry] of entries.entries()) {
    if (entry.type === 'message') {
      transcript.push({ kind: 'message', entry });
      positioned.push({ entry, position });
    } else if (entry.type === 'compaction') {
      transcript.push({ kind: 'compaction', entry });
      compactions.push({ entry, position });
    }
  }

  const lastCompaction = compactions[compactions.length - 1];
  if (lastCompaction === undefined) {
    return {
      summary: undefined,
      contextEntries: positioned.map(item => item.entry),
      transcript,
      messagesSinceCompaction: positioned.length,
    };
  }

  const previousPosition = compactions[compactions.length - 2]?.position ?? -1;

  // 保留区间只能从上一次压缩之后的段落里找：更早的消息已被前几次压缩摘要
  const segment = positioned.filter(
    item =>
      item.position > previousPosition &&
      item.position < lastCompaction.position,
  );
  const retainedIndex = segment.findIndex(
    item => item.entry.id === lastCompaction.entry.firstRetainedEntryId,
  );
  if (retainedIndex === -1) {
    return {
      summary: undefined,
      contextEntries: positioned.map(item => item.entry),
      transcript,
      messagesSinceCompaction: positioned.length,
    };
  }

  const afterCompaction = positioned.filter(
    item => item.position > lastCompaction.position,
  );
  const contextEntries = [
    ...segment.slice(retainedIndex).map(item => item.entry),
    ...afterCompaction.map(item => item.entry),
  ];
  // 系统消息是提示词血统，不是对话内容：文件里最后一条系统消息必须始终在
  // 上下文中充当刷新基线，否则恢复后无基线，首个 run 会重复追加一条相同的系统消息
  if (!contextEntries.some(entry => entry.message.role === 'system')) {
    const lastSystem = lastSystemEntry(positioned);
    if (lastSystem !== undefined) {
      contextEntries.unshift(lastSystem);
    }
  }
  return {
    summary: lastCompaction.entry.summary,
    contextEntries,
    transcript,
    messagesSinceCompaction: afterCompaction.length,
  };
}

// 按文件位置排列的最后一条系统消息条目
function lastSystemEntry(
  positioned: readonly { entry: SessionMessageEntry; position: number }[],
): SessionMessageEntry | undefined {
  for (let index = positioned.length - 1; index >= 0; index--) {
    const item = positioned[index];
    if (item?.entry.message.role === 'system') {
      return item.entry;
    }
  }
  return undefined;
}
