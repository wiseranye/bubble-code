import process from 'node:process';
import chalk from 'chalk';
import {
  type Component,
  Container,
  Editor,
  Key,
  matchesKey,
  Spacer,
  Text,
  type TUI,
  type TuiInputListenerResult,
} from '@earendil-works/pi-tui';
import {type ChatMessage, type ChatSession} from '../chat-session.js';
import {
  AssistantMessageView,
  createMessageView,
  type MessageView,
} from './message-view.js';
import {editorTheme, style} from './theme.js';

// 底部提示行
const hintText =
  'Enter 发送 · Shift+Enter 换行 · ↑↓ 历史 · Ctrl+U 清空 · Esc 取消 · Ctrl+C 退出';

export function createChatApp(tui: TUI, session: ChatSession): void {
  const messageArea = new Container();
  const indicatorSlot = new Container();
  const views = new Map<number, MessageView>();
  let indicator: BubblingIndicator | undefined;

  const editor = new Editor(tui, editorTheme, {paddingX: 1});
  editor.onSubmit = text => {
    session.send(text);
  };

  editor.disableSubmit = session.isStreaming;

  const addMessage = (message: ChatMessage): void => {
    const view = createMessageView(message, () => tui.requestRender());
    views.set(message.id, view);
    messageArea.addChild(view);
    // 每条消息后留一个空行
    messageArea.addChild(new Spacer(1));
  };

  const sealMessage = (message: ChatMessage): void => {
    const view = views.get(message.id);
    if (view instanceof AssistantMessageView) {
      // 冻结前把语法高亮算完，之后这条消息不再修改
      void view.seal().then(() => tui.requestRender());
    }
  };

  const setStreaming = (isStreaming: boolean): void => {
    editor.disableSubmit = isStreaming;
    if (isStreaming) {
      if (indicator === undefined) {
        indicator = new BubblingIndicator(() => tui.requestRender());
        indicatorSlot.addChild(indicator);
      }
    } else if (indicator !== undefined) {
      indicator.dispose();
      indicator = undefined;
      indicatorSlot.clear();
    }
  };

  const handleKey = (data: string): TuiInputListenerResult => {
    if (matchesKey(data, Key.ctrl('c'))) {
      tui.stop();
      // Ctrl+C 直接退出：这是前台 TUI 进程，退出就是它的职责
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(0);
    }

    if (matchesKey(data, Key.escape)) {
      if (session.isStreaming) {
        session.cancel();
      } else {
        editor.setText('');
      }

      return {consume: true};
    }

    return undefined;
  };

  // 已有的消息（欢迎语）在订阅之前就存在，直接补建视图
  for (const message of session.messages) {
    addMessage(message);
  }

  const root = new Container();
  root.addChild(messageArea);
  root.addChild(indicatorSlot);
  root.addChild(editor);
  root.addChild(new Text(style.dim(hintText), 1, 0));
  tui.addChild(root);
  tui.setFocus(editor);
  tui.addInputListener(handleKey);

  session.subscribe(event => {
    switch (event.type) {
      case 'message_added': {
        addMessage(event.message);
        break;
      }

      case 'message_updated': {
        views.get(event.message.id)?.update(event.message);
        break;
      }

      case 'message_sealed': {
        sealMessage(event.message);
        break;
      }

      case 'streaming_changed': {
        setStreaming(event.isStreaming);
        break;
      }

      default: {
        break;
      }
    }

    tui.requestRender();
  });
}

// 生成中的状态行：一个小气泡鼓起来再缩回去的动画
const bubbleFrames = ['·', '∘', '○', '∘'];
const bubbleInterval = 160;

class BubblingIndicator implements Component {
  private frame = 0;
  private readonly timer: NodeJS.Timeout;

  constructor(requestRender: () => void) {
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % bubbleFrames.length;
      requestRender();
    }, bubbleInterval);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {
    // 没有缓存，不需要清
  }

  render(_width: number): string[] {
    const frame = bubbleFrames[this.frame] ?? '○';
    return [`${chalk.bold.yellow(frame)}${chalk.yellow(' Bubbling ...')}`, ''];
  }
}
