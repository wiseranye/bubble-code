import { expect, test } from 'vitest';
import { PiModelApi } from '../../src/llm/api/pi-model-api.ts';
import { ModelCatalog } from '../../src/llm/model-catalog.ts';
import type { Settings } from '../../src/setting-manager.ts';

const settings: Settings = {
  compactThreshold: 0.8,
  compactRetainRatio: 0.16,
  providers: [
    {
      name: 'alpha',
      type: 'openai-completions',
      baseUrl: 'https://alpha.example.com/v1',
      apiKey: 'k1',
      models: [{ id: 'a1' }, { id: 'a2', contextWindow: 64_000 }],
    },
    {
      name: 'beta',
      type: 'anthropic-messages',
      baseUrl: 'https://beta.example.com',
      apiKey: 'k2',
      models: [{ id: 'b1' }],
    },
  ],
};

test('choices flatten providers in order and current defaults to the first', () => {
  const catalog = new ModelCatalog(settings);

  expect(
    catalog.choices.map(choice => `${choice.provider.name}/${choice.model.id}`),
  ).toEqual(['alpha/a1', 'alpha/a2', 'beta/b1']);
  expect(catalog.current).toBe(catalog.choices[0]);
});

test('select changes the current choice', () => {
  const catalog = new ModelCatalog(settings);
  const target = catalog.choices[2];
  expect(target).toBeDefined();

  catalog.select(target!);

  expect(catalog.current).toBe(target);
});

test('empty providers yield no choices and no current', () => {
  const catalog = new ModelCatalog({
    compactThreshold: 0.8,
    compactRetainRatio: 0.16,
    providers: [],
  });

  expect(catalog.choices).toEqual([]);
  expect(catalog.current).toBeUndefined();
});

test('createApi builds a PiModelApi for the choice', () => {
  const catalog = new ModelCatalog(settings);

  expect(catalog.createApi(catalog.choices[0]!)).toBeInstanceOf(PiModelApi);
});

test('contextWindow honors the settings override and falls back to the default', () => {
  const catalog = new ModelCatalog(settings);

  // 假 provider 名不会命中 pi 的 builtin catalog：显式配置生效，缺省兜底 256k
  expect(catalog.contextWindow(catalog.choices[1]!)).toBe(64_000);
  expect(catalog.contextWindow(catalog.choices[0]!)).toBe(256_000);
});
