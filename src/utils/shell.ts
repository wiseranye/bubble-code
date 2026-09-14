// 子进程生命周期管理：进程退出时的兜底清理。
// bash 工具在运行期间依赖 execa 的 cancelSignal + killDescendants 处理取消和超时，
// 这里只负责「父进程直接退出」的场景：'exit' 事件里只能做同步操作，kill 恰好是同步的，
// 用 SIGKILL 杀掉整个进程组，不留孤儿进程。
// （execa 的 cleanup 选项在退出时只发 SIGTERM，无视 TERM 的进程会漏掉）
import process from 'node:process';
import {spawnSync} from 'node:child_process';

// 正在运行的子进程 pid
const runningPids = new Set<number>();

export function trackChildProcess(pid: number): void {
  runningPids.add(pid);
}

export function untrackChildProcess(pid: number): void {
  runningPids.delete(pid);
}

// 杀掉 pid 所在的整个进程组（子进程以 detached 方式启动，自己是组长）。
// 进程组里的孙进程一并处理，防止命令自己再起的后台进程被漏掉。
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

// 杀掉所有还在执行的子进程
export function killTrackedChildren(): void {
  for (const pid of runningPids) {
    killProcessTree(pid);
  }

  runningPids.clear();
}

// 兜底：进程以任何正常路径退出（Ctrl+C 的 process.exit、main 正常返回）时，
// 同步清理还在执行的子进程。'exit' 事件里只能做同步操作，kill 恰好是同步的。
process.on('exit', killTrackedChildren);
