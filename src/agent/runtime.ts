import { homedir } from 'node:os';
import { join, normalize, resolve } from 'node:path';

function resolveHome(): string {
  const appHome = process.env.BUBBLE_HOME?.trim();
  return appHome ? resolve(appHome) : join(homedir(), '.bubble');
}

export class Runtime {
  private readonly _cwd: string;
  private readonly _homeDir: string;

  constructor(homeDir?: string) {
    this._cwd = process.cwd();
    this._homeDir = homeDir ? normalize(homeDir) : resolveHome();
  }

  cwd(): string {
    return this._cwd;
  }

  homeDir(): string {
    return this._homeDir;
  }
}

export function initRuntime(homeDir?: string): Runtime {
  return new Runtime(homeDir);
}
