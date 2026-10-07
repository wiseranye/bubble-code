import process from 'node:process';

// 设置终端标题
export function setTerminalTitle(title: string) {
  process.stdout.write(`\x1b]0;${title}\x07`);
}
