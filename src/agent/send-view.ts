import type { AgentMessage } from '../llm/types.ts';

// 发送视图：存储列表里可能按生产顺序散布多条系统消息（刷新时追加），
// 发给 provider 时只保留最后一条并移到开头，其余消息保持原序。
// 存储层（内存与会话文件）不做这个重排
export function projectSendView(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  let lastSystemIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'system') {
      lastSystemIndex = index;
      break;
    }
  }
  if (lastSystemIndex === -1) {
    return [...messages];
  }

  const view: AgentMessage[] = [];
  const lastSystem = messages[lastSystemIndex];
  if (lastSystem !== undefined) {
    view.push(lastSystem);
  }
  for (const [index, message] of messages.entries()) {
    if (index === lastSystemIndex || message.role === 'system') {
      continue;
    }
    view.push(message);
  }
  return view;
}
