import { homedir } from 'node:os';
import process from 'node:process';
import {
  type Component,
  Container,
  Editor,
  getKeybindings,
  Key,
  matchesKey,
  type OverlayHandle,
  ScrollView,
  type SelectList,
  Spacer,
  type StackChild,
  stripTerminalSequences,
  Text,
  type TuiInputListenerResult,
  type ViewportTUI,
  VStack,
  visibleWidth,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type {
  AgentSession,
  AgentSessionEvent,
  ChatMessage,
} from '../agent/agent-session.ts';
import {
  loadSessionFileEntries,
  type SessionFileEntry,
} from '../agent/session-manager.ts';
import type { ModelCatalog, ModelChoice } from '../llm/model-catalog.ts';
import type { StatusBarConfig } from '../setting-manager.ts';
import type { ToolRegistry } from '../tools/types.ts';
import { readGitBranch } from '../utils/git.ts';
import { LogoBanner } from './logo.ts';
import {
  AssistantMessageView,
  createMessageView,
  type MessageView,
} from './message-view.ts';
import { ModelPicker } from './model-picker.ts';
import { SessionPicker } from './session-picker.ts';
import {
  matchSlashCommand,
  SlashCommandAutocomplete,
  type SlashCommandInvocation,
  slashCommandArgumentPlaceholder,
  slashCommandTakesArgument,
} from './slash-command.ts';
import { StatusBar, type StatusBarData } from './status-bar.ts';
import { editorTheme, style } from './theme.ts';

// 底部提示行
const hintText =
  'Enter 发送 · Shift+Enter 换行 · / 命令 · ↑↓ 历史 · Ctrl+U 清空 · Esc 取消 · Ctrl+C 退出';

export function createChatApp(
  tui: ViewportTUI,
  createSession: (sessionFile?: string) => AgentSession,
  tools: ToolRegistry,
  catalog: ModelCatalog,
  statusBarConfig: StatusBarConfig,
): void {
  // 转录文档：启动横幅 + 消息区。全屏模式下它挂在 ScrollView 里滚动，
  // /new、/resume 只清消息区，横幅不会被带走
  const transcript = new Container();
  const messageArea = new Container();
  transcript.addChild(new LogoBanner());
  transcript.addChild(messageArea);
  const indicatorSlot = new Container();
  const views = new Map<number, MessageView>();
  let indicator: BubblingIndicator | undefined;

  let session = createSession();
  let branch: string | undefined;
  let branchRefreshId = 0;

  // 状态栏的 Git 分支：异步刷新，旧请求的结果直接丢弃；禁用状态栏时不启动 git
  const refreshBranch = (): void => {
    if (!statusBarConfig.enable) {
      return;
    }

    const refreshId = ++branchRefreshId;
    void readGitBranch(process.cwd()).then(state => {
      if (refreshId !== branchRefreshId) {
        return;
      }

      if (state.kind === 'branch') {
        branch = state.name;
      } else if (state.kind === 'detached') {
        branch = `@${state.sha}`;
      } else {
        branch = undefined;
      }

      tui.requestRender();
    });
  };

  const getStatusData = (): StatusBarData => {
    const choice = catalog.current;
    const stats = session.contextStats;
    const cacheRead = stats.cacheRead;
    const cacheWrite = stats.cacheWrite;
    const cache: StatusBarData['cache'] =
      choice !== undefined &&
      cacheRead !== undefined &&
      cacheWrite !== undefined &&
      cacheRead + cacheWrite > 0
        ? { read: cacheRead, promptTokens: stats.promptTokens ?? 0 }
        : undefined;

    return {
      model:
        choice === undefined
          ? undefined
          : {
              label: `${choice.provider.name}/${choice.model.name ?? choice.model.id}`,
              reasoning: choice.model.reasoning,
            },
      cwd: process.cwd(),
      homeDir: homedir(),
      branch,
      context:
        choice === undefined
          ? undefined
          : { used: stats.usedTokens, window: stats.contextWindow },
      cache,
    };
  };

  const statusBarView = statusBarConfig.enable
    ? new StatusBar({
        style: statusBarConfig.style,
        getData: getStatusData,
      })
    : undefined;

  const addMessage = (message: ChatMessage): void => {
    const view = createMessageView(message, tools, () => tui.requestRender());
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

  let streaming = false;
  let compacting = false;
  const setStreaming = (isStreaming: boolean): void => {
    streaming = isStreaming;
    editor.disableSubmit = streaming || compacting;
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
    // 弹窗打开时按键全部交给弹窗处理（Esc / Ctrl+C 由 SelectList 走取消）
    if (tui.hasOverlay()) {
      return undefined;
    }

    if (matchesKey(data, Key.ctrl('c'))) {
      // 全屏模式退出时不重画"文档"：转录区在非布局上下文里只剩 1 行，
      // 重画出来的是半截画面，直接切回普通屏更干净（pi 的做法）
      tui.stop({ preserveScreen: true });
      // Ctrl+C 直接退出：这是前台 TUI 进程，退出就是它的职责
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(0);
    }

    if (matchesKey(data, Key.escape)) {
      if (session.isStreaming || session.isCompacting) {
        session.cancel();
      } else {
        editor.setText('');
      }

      return { consume: true };
    }

    return undefined;
  };

  const handleSessionEvent = (event: AgentSessionEvent): void => {
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

      case 'compaction_changed': {
        // 压缩不碰 Bubbling 指示器（消息区有「压缩中」行），只禁用输入
        compacting = event.isCompacting;
        editor.disableSubmit = streaming || compacting;
        break;
      }

      case 'status_refresh': {
        refreshBranch();
        break;
      }

      default: {
        break;
      }
    }

    tui.requestRender();
  };

  let unsubscribeSession = (): void => {};

  // 重新绑定会话：退订旧会话，清空视图，订阅新会话并补建已有消息（欢迎语）
  const bindSession = (): void => {
    unsubscribeSession();
    views.clear();
    messageArea.clear();
    unsubscribeSession = session.subscribe(handleSessionEvent);
    for (const message of session.messages) {
      addMessage(message);
    }

    tui.requestRender();
  };

  // /resume：恢复选中的会话。可能选中的就是当前会话的文件，
  // 必须先等旧会话的写入落盘，再重新读文件
  const resumeSession = async (entry: SessionFileEntry): Promise<void> => {
    await session.dispose();
    try {
      session = createSession(entry.filePath);
    } catch (error: unknown) {
      // 会话文件损坏等情况：退回新会话，不把界面卡死
      session = createSession();
      bindSession();
      const detail = error instanceof Error ? error.message : String(error);
      session.notify(`恢复会话失败：${detail}`);
      return;
    }

    bindSession();
    session.notify(`已恢复会话：${entry.title}`);
  };

  // /resume：弹出当前目录的历史会话列表
  const openSessionPicker = (): void => {
    const entries = loadSessionFileEntries(process.cwd());
    if (entries.length === 0) {
      session.notify('当前目录下没有历史会话');
      return;
    }

    let overlay: OverlayHandle | undefined;
    const close = (): void => {
      overlay?.hide();
      overlay = undefined;
    };
    const picker = new SessionPicker(
      entries,
      entry => {
        close();
        void resumeSession(entry);
      },
      close,
    );
    overlay = tui.showOverlay(picker, {
      width: '70%',
      maxHeight: 14,
      anchor: 'center',
    });
  };

  // /model：切换当前选中的模型。选中项是 app 级状态，/new、/resume 的新会话跟随
  const switchModel = (choice: ModelChoice): void => {
    catalog.select(choice);
    session.setModel(catalog.createApi(choice), catalog.contextWindow(choice));
    session.notify(
      `已切换模型：${choice.provider.name}/${choice.model.name ?? choice.model.id}`,
    );
  };

  // /model：弹出可选模型列表
  const openModelPicker = (): void => {
    let overlay: OverlayHandle | undefined;
    const close = (): void => {
      overlay?.hide();
      overlay = undefined;
    };
    const picker = new ModelPicker(
      catalog.choices,
      catalog.current,
      choice => {
        close();
        // 选中的就是当前模型：不重复切换，避免无谓的历史清洗
        if (choice !== catalog.current) {
          switchModel(choice);
        }
      },
      close,
    );
    overlay = tui.showOverlay(picker, {
      width: '70%',
      maxHeight: 14,
      anchor: 'center',
    });
  };

  // 斜杠命令的执行入口，UI 只负责分发到这里
  const runSlashCommand = (
    invocation: SlashCommandInvocation,
    text: string,
  ): void => {
    switch (invocation.command.name) {
      case 'new': {
        if (session.isStreaming) {
          session.notify('请等待当前会话结束');
          break;
        }

        // 新会话用新文件，不需要等旧会话落盘
        void session.dispose();
        session = createSession();
        bindSession();
        break;
      }

      case 'resume': {
        if (session.isStreaming) {
          session.notify('请等待当前会话结束');
          break;
        }

        openSessionPicker();
        break;
      }

      case 'compact': {
        if (session.isStreaming) {
          session.notify('请等待当前会话结束');
          break;
        }

        void session.compact();
        break;
      }

      case 'model': {
        if (session.isStreaming || session.isCompacting) {
          session.notify('请等待当前会话结束');
          break;
        }

        if (catalog.choices.length === 0) {
          session.notify(
            '未配置模型，请先在 settings.jsonc 的 providers 中配置模型',
          );
          break;
        }

        openModelPicker();
        break;
      }

      case 'quit': {
        tui.stop({ preserveScreen: true });
        process.exit(0);
        // process.exit 不会返回，break 只是为了过 lint
        break;
      }

      default: {
        // 未实现的命令按普通输入处理，/ 开头的提示词照常发给模型
        session.prompt(text);
        break;
      }
    }
  };

  const editor = new PromptEditor(tui, editorTheme, { paddingX: 2 });
  editor.setAutocompleteProvider(new SlashCommandAutocomplete());
  editor.onSubmit = text => {
    const invocation = matchSlashCommand(text);
    if (invocation !== undefined) {
      // 带参数的命令只输了命令名：不发送，补成 "/name " 留在输入框里，
      // 参数占位提示由 PromptEditor 渲染，用户接着输入参数
      if (
        invocation.command.argumentHint !== undefined &&
        invocation.argument === ''
      ) {
        editor.setText(`/${invocation.command.name} `);
        return;
      }

      runSlashCommand(invocation, text);
      return;
    }

    session.prompt(text);
  };

  editor.disableSubmit = session.isStreaming;

  // 转录区自己滚动：新内容贴底，向上滚过之后不再被新输出拽回去
  const transcriptView = new ScrollView(transcript, {
    follow: 'end',
    primary: true,
  });
  // 底部固定区，不随转录滚动：生成状态、状态栏、输入框、提示行
  const dockChildren: StackChild[] = [
    { component: indicatorSlot, shrink: 1, minSize: 0 },
  ];
  if (statusBarView !== undefined) {
    dockChildren.push({ component: statusBarView, shrink: 1, minSize: 0 });
  }
  dockChildren.push(
    { component: editor, shrink: 1, minSize: 3 },
    { component: new Text(style.dim(hintText), 1, 0), shrink: 1, minSize: 0 },
  );
  const dock = new VStack(dockChildren);
  // 全屏布局：转录区吃满剩余高度，底部固定区按内容高度贴着视口下沿
  tui.setLayoutRoot(
    new VStack([
      { component: transcriptView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
    ]),
  );
  tui.setFocus(editor);
  tui.addInputListener(handleKey);

  // 已有的消息（欢迎语）在订阅之前就存在，bindSession 里直接补建视图
  bindSession();
  refreshBranch();
}

// 斜杠命令的参数占位提示从行尾 padding 里借位置：用暗色提示替换等宽的空格，
// 整行宽度不变。空间不够（窄终端）就不显示
function appendPlaceholder(line: string, placeholder: string): string {
  const placeholderWidth = visibleWidth(placeholder);
  const trailing = /( +)$/.exec(line)?.[1];
  if (trailing === undefined || trailing.length <= placeholderWidth) {
    return line;
  }

  return `${line.slice(0, line.length - trailing.length)}${style.dim(placeholder)}${' '.repeat(trailing.length - placeholderWidth)}`;
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
    // 输入恰好是 "/rename" / "/rename " 这类还没填参数的命令时，
    // 在首行文本末尾挂暗色的参数占位提示（如 <会话名称>）。
    // 只在光标位于文本末尾时显示：提示贴在光标后面，光标挪回命令中间就不提示
    const text = this.getText();
    const cursor = this.getCursor();
    const placeholder =
      cursor.line === 0 && cursor.col === text.length
        ? slashCommandArgumentPlaceholder(text)
        : undefined;

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
      let content =
        index === 1 && line.startsWith(' ')
          ? style.prompt('❯') + line.slice(1)
          : line;
      if (index === 1 && placeholder !== undefined) {
        content = appendPlaceholder(content, placeholder);
      }

      return `${this.borderColor('│')}${content}${this.borderColor('│')}`;
    });
  }

  override handleInput(data: string): void {
    // 带参数的命令（如 /rename）在弹层里回车只补全命令名，不提交，留给用户输入参数。
    // Editor 原生对 / 前缀的补全回车会顺带提交，这里把回车换成 Tab 的行为
    const keybindings = getKeybindings();
    if (
      keybindings.matches(data, 'tui.select.confirm') &&
      this.isShowingAutocomplete()
    ) {
      // autocompleteList 是 Editor 的私有字段，这里和 render 一样只做读取
      const list = (this as unknown as { autocompleteList?: SelectList })
        .autocompleteList;
      const selected = list?.getSelectedItem();
      if (selected !== null && selected !== undefined) {
        if (slashCommandTakesArgument(selected.value)) {
          super.handleInput('\t');
          return;
        }
      }
    }

    // 生成中禁止提交普通消息，但斜杠命令放行：
    // 命令能不能执行由 runSlashCommand 判断（比如 /new 会提示等待当前会话结束）
    if (
      this.disableSubmit &&
      keybindings.matches(data, 'tui.input.submit') &&
      this.getText().trimStart().startsWith('/')
    ) {
      this.disableSubmit = false;
      super.handleInput(data);
      this.disableSubmit = true;
      return;
    }

    super.handleInput(data);
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
