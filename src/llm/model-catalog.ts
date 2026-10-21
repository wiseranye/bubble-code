import type {
  ModelConfig,
  ProviderConfig,
  Settings,
} from '../setting-manager.ts';
import { assembleModel, PiModelApi } from './api/pi-model-api.ts';
import type { ModelApi } from './types.ts';

// 一个可选模型 = provider + 其下的一个 model 配置
export type ModelChoice = {
  provider: ProviderConfig;
  model: ModelConfig;
};

// settings 的 providers 拍平成的可选模型列表 + 当前选中项。
// app 级状态：/new、/resume 建的新会话跟随当前选中项
export class ModelCatalog {
  readonly choices: readonly ModelChoice[];

  private selected: ModelChoice | undefined;

  constructor(settings: Settings) {
    this.choices = settings.providers.flatMap(provider =>
      provider.models.map(model => ({ provider, model })),
    );
    this.selected = this.choices[0];
  }

  get current(): ModelChoice | undefined {
    return this.selected;
  }

  select(choice: ModelChoice): void {
    this.selected = choice;
  }

  createApi(choice: ModelChoice): ModelApi {
    return new PiModelApi(choice.provider, choice.model);
  }

  contextWindow(choice: ModelChoice): number {
    return assembleModel(choice.provider, choice.model).contextWindow;
  }
}
