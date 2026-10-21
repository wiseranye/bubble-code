import { createInterface } from 'node:readline';
import { rgPath } from '@vscode/ripgrep';
import { execa } from 'execa';

export interface RipgrepRunOptions {
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeout?: number;
  // 返回 false 会主动终止 rg，用于 limit 或输出保护
  onStdoutLine(line: string): boolean;
}

export interface RipgrepRunResult {
  stderr: string;
  exitCode: number | undefined;
  timedOut: boolean;
  canceled: boolean;
  stoppedByConsumer: boolean;
  failed: boolean;
  message?: string;
}

export async function runRipgrep(
  options: RipgrepRunOptions,
): Promise<RipgrepRunResult> {
  const subprocess = execa(rgPath, options.args, {
    reject: false,
    cwd: options.cwd,
    cancelSignal: options.signal,
    timeout: options.timeout ?? 0,
    encoding: 'utf8',
    buffer: false,
    stdin: 'ignore',
  });
  const stdout = subprocess.stdout;
  const stderrStream = subprocess.stderr;
  if (!stdout || !stderrStream) {
    throw new Error('failed to capture ripgrep output');
  }

  let stderr = '';
  let stoppedByConsumer = false;
  let consumerError: unknown;

  const consumeStderr = (async () => {
    for await (const chunk of stderrStream) {
      stderr += chunk;
    }
  })();

  const consumeStdout = (async () => {
    const lines = createInterface({ input: stdout, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!options.onStdoutLine(line)) {
          stoppedByConsumer = true;
          subprocess.kill();
          break;
        }
      }
    } catch (error: unknown) {
      consumerError = error;
      stoppedByConsumer = true;
      subprocess.kill();
    } finally {
      lines.close();
      stdout.destroy();
    }
  })();

  const [result] = await Promise.all([
    subprocess,
    consumeStdout,
    consumeStderr,
  ]);

  if (consumerError !== undefined) {
    throw consumerError;
  }

  return {
    stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    canceled: result.isCanceled || options.signal?.aborted === true,
    stoppedByConsumer,
    failed: result.failed,
    message: result.message,
  };
}
