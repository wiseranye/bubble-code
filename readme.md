# bubble-code

一个在终端里运行的编码智能体（coding agent）。在对话窗口里输入需求，Agent
调用模型与工具完成代码任务。

界面基于 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi)：
主屏渲染、差分刷新，消息历史留在终端 scrollback 里。

## 功能

- 对话窗口：消息历史 + 底部输入框（pi-tui `Editor`）
- 用户消息（`❯`）与助手消息（`✦`）分区显示，助手回复按 Markdown 渲染（shiki 语法高亮）
- 工具调用（`⚙`/`✗`）就地展示输入与输出（超过 8 行折叠）
- 流式输出，`Esc` 取消生成
- 输入编辑：左右移动光标、退格/删除、`Ctrl+A/E/U/K/W`、`↑↓` 翻阅历史
- `Enter` 发送、`Shift+Enter`（部分终端为 `Alt+Enter`）换行、`Ctrl+C` 退出

## 安装与运行

需要 Node.js >= 22.19，以及交互式终端（TTY）。

```bash
pnpm install
pnpm build
node dist/cli.js
```

## 开发

```bash
pnpm build   # 清理 dist 后重新编译
pnpm dev     # tsc --watch
pnpm test    # prettier + xo + build + ava
```

## 结构

```
src/
  cli.ts                  # CLI 入口（参数解析、TTY 检查、启动渲染器）
  chat-session.ts         # ChatSession：消息列表、Agent 事件映射、取消/错误（无 UI）
  ui/
    app.ts                # 组装消息区 / 输入框 / 提示行与键盘接线
    message-view.ts       # user / assistant / tool / system 消息组件
    theme.ts              # pi-tui 编辑器与 Markdown 主题、shiki 高亮回调
  agent/                  # Agent 循环（模型 + 工具）
  model/                  # LLM 协议与 OpenAI 实现
  markdown/
    highlight.ts          # shiki 代码高亮（同步缓存 + 异步计算）
  tools/                  # 工具注册与 bash 工具
  utils/
```

接入真实模型时，实现 `src/model/llm.ts` 里的 `Model` 接口即可（`OpenAiModel`
已接通 OpenAI 兼容协议）。领域术语与架构决策见 `CONTEXT.md` 与 `docs/adr/`。
