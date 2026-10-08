import process from 'node:process';
import {
  type Component,
  Container,
  Editor,
  Key,
  matchesKey,
  Spacer,
  stripTerminalSequences,
  Text,
  type TUI,
  type TuiInputListenerResult,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type { AgentSession, ChatMessage } from '../agent/agent-session.ts';
import {
  AssistantMessageView,
  createMessageView,
  type MessageView,
} from './message-view.ts';
import { editorTheme, style } from './theme.ts';

// 底部提示行
const hintText =
  'Enter 发送 · Shift+Enter 换行 · ↑↓ 历史 · Ctrl+U 清空 · Esc 取消 · Ctrl+C 退出';

export function createChatApp(tui: TUI, session: AgentSession): void {
  const messageArea = new Container();
  const indicatorSlot = new Container();
  const views = new Map<number, MessageView>();
  let indicator: BubblingIndicator | undefined;

  const editor = new PromptEditor(tui, editorTheme, { paddingX: 2 });
  editor.onSubmit = text => {
    session.prompt(text);
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

      return { consume: true };
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

// 四边框输入框，首行内容区左侧 padding 放提示符，像 shell 的 prompt。
// Editor 原生只画上下两条横线，左右边框和提示符都在 render 后处理；
// 继承而不是包装，鼠标/焦点行为原样保留，handleMouse 里补偿边框占掉的偏移。
class PromptEditor extends Editor {
  override render(width: number): string[] {
    const innerWidth = Math.max(3, width - 2);
    const lines = super.render(innerWidth);
    // 第 0 行是上边框，1..visibleLineCount 是内容行，
    // 再往后是下边框和 autocomplete 弹层（弹层不画边框）
    const visibleLineCount = (
      this as unknown as { renderedVisibleLineCount: number }
    ).renderedVisibleLineCount;
    const bottomBorderIndex = 1 + visibleLineCount;

    return lines.map((line, index) => {
      if (index > bottomBorderIndex) {
        return line;
      }

      const plain = stripTerminalSequences(line);
      if (index === 0) {
        return this.borderColor(`┌${plain}┐`);
      }

      if (index === bottomBorderIndex) {
        return this.borderColor(`└${plain}┘`);
      }

      // 首行内容：左侧 padding 的首列换成提示符。
      // ❯（U+276F）垂直居中，ASCII > 是基线对齐，视觉上会偏下
      const content =
        index === 1 && line.startsWith(' ')
          ? style.prompt('❯') + line.slice(1)
          : line;
      return `${this.borderColor('│')}${content}${this.borderColor('│')}`;
    });
  }

  override handleMouse(
    event: Parameters<Editor['handleMouse']>[0],
  ): ReturnType<Editor['handleMouse']> {
    // 左右边框各占一列；Editor 内部的点击定位以内容区宽度为准，需要同步收窄
    return super.handleMouse({
      ...event,
      x: event.x - 1,
      width: Math.max(3, event.width - 2),
    });
  }
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
