import {
  type Component,
  Container,
  type ViewportTUI,
} from '@earendil-works/pi-tui';
import { expect, test } from 'vitest';
import { AppUiContext } from '../../src/ui/app-ui-context.ts';
import type { UiComponent } from '../../src/ui/ui-context.ts';

function createContext() {
  const editor: UiComponent & { focused: boolean } = {
    focused: false,
    render: () => [],
    invalidate: () => undefined,
  };
  const dialogSlot = new Container();
  const widgetSlots = {
    aboveEditor: new Container(),
    belowEditor: new Container(),
  };
  let focused: Component | null = null;
  let overlayCount = 0;
  const tui = {
    setFocus: (component: Component | null) => {
      focused = component;
    },
    hasOverlay: () => overlayCount > 0,
    showOverlay: () => {
      overlayCount++;
      return {
        hide: () => {
          overlayCount--;
        },
      };
    },
    requestRender: () => undefined,
  } as unknown as ViewportTUI;
  const notifications: Array<{ message: string; level?: string }> = [];
  const context = new AppUiContext({
    tui,
    editor,
    dialogSlot,
    widgetSlots,
    notify: (message, level) => notifications.push({ message, level }),
  });
  return {
    context,
    editor,
    dialogSlot,
    widgetSlots,
    notifications,
    getFocused: () => focused,
  };
}

function component(dispose?: () => void): UiComponent {
  return {
    render: () => [],
    invalidate: () => undefined,
    dispose,
  };
}

test('custom stacks inline components and restores the previous focus', async () => {
  const { context, editor, dialogSlot, getFocused } = createContext();
  let finishFirst: (result: string) => void = () => undefined;
  let finishSecond: (result: string) => void = () => undefined;
  const first = component();
  const second = component();

  const firstResult = context.custom<string>((_environment, done) => {
    finishFirst = done;
    return first;
  });
  const secondResult = context.custom<string>((_environment, done) => {
    finishSecond = done;
    return second;
  });

  expect(dialogSlot.children).toEqual([second]);
  expect(getFocused()).toBe(second);
  finishSecond('second');
  await expect(secondResult).resolves.toBe('second');
  expect(dialogSlot.children).toEqual([first]);
  expect(getFocused()).toBe(first);
  expect(context.hasInlinePrompts).toBe(true);

  finishFirst('first');
  await expect(firstResult).resolves.toBe('first');
  expect(dialogSlot.children).toEqual([]);
  expect(getFocused()).toBe(editor);
  expect(context.hasPrompts).toBe(false);
});

test('custom abort settles the prompt and disposes its component', async () => {
  const { context, editor, getFocused } = createContext();
  const controller = new AbortController();
  let disposed = false;
  const result = context.custom<string>(
    () =>
      component(() => {
        disposed = true;
      }),
    { signal: controller.signal },
  );

  controller.abort();

  await expect(result).resolves.toBeUndefined();
  expect(disposed).toBe(true);
  expect(context.hasPrompts).toBe(false);
  expect(getFocused()).toBe(editor);
});

test('overlay prompts close without replacing the editor slot', async () => {
  const { context, dialogSlot } = createContext();
  let finish: (result: string) => void = () => undefined;
  const result = context.custom<string>(
    (_environment, done) => {
      finish = done;
      return component();
    },
    { placement: 'overlay' },
  );

  expect(context.hasPrompts).toBe(true);
  expect(context.hasInlinePrompts).toBe(false);
  expect(dialogSlot.children).toEqual([]);
  finish('done');

  await expect(result).resolves.toBe('done');
  expect(context.hasPrompts).toBe(false);
});

test('widgets are replaceable, movable and disposable', () => {
  const { context, widgetSlots } = createContext();
  let disposed = false;
  context.setWidget('todo', ['first']);
  expect(widgetSlots.aboveEditor.children).toHaveLength(1);

  context.setWidget(
    'todo',
    () =>
      component(() => {
        disposed = true;
      }),
    { placement: 'belowEditor' },
  );
  expect(widgetSlots.aboveEditor.children).toHaveLength(0);
  expect(widgetSlots.belowEditor.children).toHaveLength(1);

  context.setWidget('todo', undefined);
  expect(disposed).toBe(true);
  expect(widgetSlots.belowEditor.children).toHaveLength(0);
});

test('notify delegates through the generic UI context', () => {
  const { context, notifications } = createContext();
  context.notify('需要确认', 'warning');
  expect(notifications).toEqual([{ message: '需要确认', level: 'warning' }]);
});
