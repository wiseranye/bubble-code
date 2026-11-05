import { readFileSync } from 'node:fs';

// 应用标识的唯一来源：MCP clientInfo、User-Agent、启动横幅都从这里取，
// 不要在调用处再写死包名或版本号。
// APP_NAME 是产品标识，不是 package.json 里带 scope 的发布标识
// （@wiseranye/bubble-code 用于 npm，协议握手与日志里希望看到 bubble-code）
export const APP_NAME = 'bubble-code';

// 界面展示名：可以带空格大小写，仅用于面向用户的文字
export const APP_DISPLAY_NAME = 'Bubble Code';

// 版本号以 package.json 为准，发版只改那一个文件。读不到说明发布物布局变了，
// 用 dev 兜底：MCP clientInfo 与 User-Agent 都不接受空版本
export const APP_VERSION = readVersion() ?? 'dev';

function readVersion(): string | undefined {
  try {
    const raw = readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8',
    );
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
  } catch {
    // 读不到就没有版本号
  }

  return undefined;
}
