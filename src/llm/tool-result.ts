import type { ToolResultMessage } from './types.ts';

// 送给模型看的工具结果文本。协议消息把 error 和 output 分开存（UI 和持久化要分别
// 使用），只有在构造模型输入时才拼起来：失败信息必须让模型看到，否则它不知道命令挂了。
export function toolResultContent(message: ToolResultMessage): string {
  if (message.error === undefined) {
    return message.output;
  }

  return [message.error, message.output].filter(Boolean).join('\n');
}
