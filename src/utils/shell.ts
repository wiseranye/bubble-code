import process from 'node:process';

// 设置终端标题
export function setTerminalTitle(title: string) {
  process.stdout.write(`\u001B]0;${title}\u0007`);
}
