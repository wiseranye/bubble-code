import { readFileSync } from 'node:fs';

// 从 package.json 读版本号；读不到（比如发布物布局变了）就返回 undefined
export function readVersion(): string | undefined {
  try {
    const raw = readFileSync(
      new URL('../../package.json', import.meta.url),
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
