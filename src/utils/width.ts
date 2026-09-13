import wrapAnsi from 'wrap-ansi';

// Approximate the visual width of a string, counting CJK and full-width
// characters as two columns. This is used to estimate how many terminal rows
// a message occupies so we can keep the latest messages on screen.
const wideCharacter =
  /[\u1100-\u115F\u2E80-\u303E\u3040-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE1F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export function stringWidth(input: string): number {
  let width = 0;
  for (const character of input) {
    width += wideCharacter.test(character) ? 2 : 1;
  }

  return width;
}

// 一段文本按终端宽度占多少行。用和 Ink 相同的换行方式，
// 这样算出来的高度能对上真实排版（实时区域的裁剪依赖这个数字）
export function wrappedHeight(text: string, width: number): number {
  return wrapRows(text, width).length;
}

// 只保留末尾 maxRows 行：实时区域在终端里只是一块视口，
// 内容比屏幕高时只显示最新部分（完整内容在消息定稿时写进 scrollback）
export function tailRows(text: string, width: number, maxRows: number): string {
  const lines = wrapRows(text, width);
  return lines.slice(Math.max(0, lines.length - maxRows)).join('\n');
}

function wrapRows(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(1, width), {trim: false, hard: true}).split(
    '\n',
  );
}
