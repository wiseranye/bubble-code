import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadSettings } from '../src/setting-manager.ts';

const dirs: string[] = [];

function withSettingsFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bubble-settings-'));
  dirs.push(dir);
  const path = join(dir, 'settings.jsonc');
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }

  dirs.length = 0;
});

test('statusBar defaults to enabled with the default style', async () => {
  const settings = await loadSettings(withSettingsFile('{}'));
  expect(settings.statusBar).toEqual({ enable: true, style: 'default' });
});

test('maxConcurrentToolCalls defaults to 10 and accepts positive integers', async () => {
  expect(
    (await loadSettings(withSettingsFile('{}'))).maxConcurrentToolCalls,
  ).toBe(10);
  expect(
    (await loadSettings(withSettingsFile('{"maxConcurrentToolCalls":1}')))
      .maxConcurrentToolCalls,
  ).toBe(1);
});

test('maxConcurrentToolCalls rejects zero and non-integers', async () => {
  await expect(
    loadSettings(withSettingsFile('{"maxConcurrentToolCalls":0}')),
  ).rejects.toThrow(/配置校验失败/);
  await expect(
    loadSettings(withSettingsFile('{"maxConcurrentToolCalls":1.5}')),
  ).rejects.toThrow(/配置校验失败/);
});

test('statusBar accepts the powerline style', async () => {
  const settings = await loadSettings(
    withSettingsFile('{"statusBar":{"enable":false,"style":"powerline"}}'),
  );
  expect(settings.statusBar).toEqual({
    enable: false,
    style: 'powerline',
  });
});

test('an unknown statusBar style is a config error', async () => {
  const path = withSettingsFile('{"statusBar":{"style":"unknown"}}');
  await expect(loadSettings(path)).rejects.toThrow(/配置校验失败/);
});
