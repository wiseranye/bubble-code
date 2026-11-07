import type { Component, TUI } from '@earendil-works/pi-tui';

export type UiComponent = Component & { dispose?(): void };

export interface UiComponentEnvironment {
  readonly tui: TUI;
  readonly requestRender: () => void;
}

export type UiComponentFactory<T> = (
  environment: UiComponentEnvironment,
  done: (result: T) => void,
) => UiComponent;

export type UiWidgetFactory = (
  environment: UiComponentEnvironment,
) => UiComponent;

export type UiPlacement = 'aboveEditor' | 'belowEditor';

// 工具可见的通用 UI 能力。接口不包含任何具体工具的输入、输出或组件类型。
export interface UiContext {
  custom<T>(
    factory: UiComponentFactory<T>,
    options?: {
      signal?: AbortSignal;
      placement?: 'replaceEditor' | 'overlay';
    },
  ): Promise<T | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  setWidget(
    key: string,
    content?: string[] | UiWidgetFactory,
    options?: { placement?: UiPlacement },
  ): void;
}
