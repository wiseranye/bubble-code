// 工具参数解析失败时通用的兜底摘要：压成一行，避免撑爆消息区
export function summariseUnknownInput(input: unknown): string {
  if (input === undefined || input === null) {
    return '';
  }

  if (typeof input === 'string') {
    return toSingleLine(input.trim());
  }

  if (isRecord(input)) {
    // 只有一个字段（比如 bash 的 command）时只显示值
    const entries = Object.entries(input);
    const single = entries.length === 1 ? entries[0] : undefined;
    if (single && typeof single[1] === 'string') {
      return toSingleLine(single[1]);
    }
  }

  return toSingleLine(JSON.stringify(input));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 多行参数（比如写文件的 content）只显示第一行
function toSingleLine(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  return rest.length > 0 ? `${first} …` : first;
}
