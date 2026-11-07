import {
  type Container,
  type OverlayHandle,
  Text,
  type ViewportTUI,
} from '@earendil-works/pi-tui';
import type {
  UiComponent,
  UiComponentEnvironment,
  UiComponentFactory,
  UiContext,
  UiPlacement,
  UiWidgetFactory,
} from './ui-context.ts';

interface DialogEntry {
  component?: UiComponent;
  overlay?: OverlayHandle;
}

interface WidgetEntry {
  readonly component: UiComponent;
  readonly placement: UiPlacement;
}

export interface AppUiContextOptions {
  readonly tui: ViewportTUI;
  readonly editor: UiComponent & { focused: boolean };
  readonly dialogSlot: Container;
  readonly widgetSlots: Readonly<Record<UiPlacement, Container>>;
  readonly notify: UiContext['notify'];
}

// App 侧的通用交互实现：只管理组件与生命周期，不认识任何具体工具。
export class AppUiContext implements UiContext {
  private readonly tui: ViewportTUI;
  private readonly editor: UiComponent & { focused: boolean };
  private readonly dialogSlot: Container;
  private readonly widgetSlots: Readonly<Record<UiPlacement, Container>>;
  private readonly notifyHandler: UiContext['notify'];
  private readonly environment: UiComponentEnvironment;
  private readonly dialogs: DialogEntry[];
  private readonly widgets: Map<string, WidgetEntry>;
  private promptCount: number;

  constructor(options: AppUiContextOptions) {
    this.tui = options.tui;
    this.editor = options.editor;
    this.dialogSlot = options.dialogSlot;
    this.widgetSlots = options.widgetSlots;
    this.notifyHandler = options.notify;
    this.environment = {
      tui: options.tui,
      requestRender: () => this.tui.requestRender(),
    };
    this.dialogs = [];
    this.widgets = new Map();
    this.promptCount = 0;
  }

  get hasPrompts(): boolean {
    return this.promptCount > 0;
  }

  get hasInlinePrompts(): boolean {
    return this.dialogs.length > 0;
  }

  hasWidgets(placement: UiPlacement): boolean {
    return [...this.widgets.values()].some(
      widget => widget.placement === placement,
    );
  }

  custom<T>(
    factory: UiComponentFactory<T>,
    options?: {
      signal?: AbortSignal;
      placement?: 'replaceEditor' | 'overlay';
    },
  ): Promise<T | undefined> {
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.resolve(undefined);
    }

    return new Promise<T | undefined>((resolve, reject) => {
      const placement = options?.placement ?? 'replaceEditor';
      const entry: DialogEntry = {};
      let component: UiComponent | undefined;
      let closed = false;
      const onAbort = (): void => close(undefined);
      const close = (result: T | undefined): void => {
        if (closed) {
          return;
        }
        closed = true;
        this.promptCount--;
        signal?.removeEventListener('abort', onAbort);
        entry.overlay?.hide();
        entry.overlay = undefined;
        if (placement === 'replaceEditor') {
          const index = this.dialogs.indexOf(entry);
          if (index >= 0) {
            this.dialogs.splice(index, 1);
          }
        }
        component?.dispose?.();
        this.showTopDialog();
        resolve(result);
      };

      this.promptCount++;
      try {
        component = factory(this.environment, close);
      } catch (error: unknown) {
        this.promptCount--;
        reject(error);
        return;
      }
      if (closed) {
        component.dispose?.();
        return;
      }

      entry.component = component;
      signal?.addEventListener('abort', onAbort, { once: true });
      if (placement === 'overlay') {
        entry.overlay = this.tui.showOverlay(component, {
          width: '80%',
          maxHeight: 24,
          anchor: 'center',
        });
        this.tui.requestRender();
      } else {
        this.dialogs.push(entry);
        this.showTopDialog();
      }
    });
  }

  notify(message: string, level?: 'info' | 'warning' | 'error'): void {
    this.notifyHandler(message, level);
  }

  setWidget(
    key: string,
    content?: string[] | UiWidgetFactory,
    options?: { placement?: UiPlacement },
  ): void {
    const previous = this.widgets.get(key);
    previous?.component.dispose?.();
    this.widgets.delete(key);
    if (content !== undefined) {
      const component = Array.isArray(content)
        ? new Text(content.join('\n'), 0, 0)
        : content(this.environment);
      this.widgets.set(key, {
        component,
        placement: options?.placement ?? 'aboveEditor',
      });
    }
    this.refreshWidgets();
  }

  private showTopDialog(): void {
    this.dialogSlot.clear();
    const component = this.dialogs.at(-1)?.component;
    if (component !== undefined) {
      this.dialogSlot.addChild(component);
    }
    if (!this.tui.hasOverlay()) {
      this.tui.setFocus(component ?? this.editor);
    }
    this.tui.requestRender();
  }

  private refreshWidgets(): void {
    for (const slot of Object.values(this.widgetSlots)) {
      slot.clear();
    }
    for (const widget of this.widgets.values()) {
      this.widgetSlots[widget.placement].addChild(widget.component);
    }
    this.tui.requestRender();
  }
}
