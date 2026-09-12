# bubble-code

一个在终端里运行的编码智能体（coding agent）。当前版本先提供了类似
OpenCode / Claude Code 的对话窗口，后续会接入真实的 LLM 后端和工具能力。

## 功能

- 全屏对话窗口：消息历史 + 底部输入框
- 用户消息（`❯`）与助手消息（`✦`）分区显示
- 流式输出占位（模拟回复，逐字打印）
- 输入编辑：左右移动光标、退格/删除、`Ctrl+A/E/U/W`
- `Enter` 发送、`Shift+Enter` 换行、`↑↓` 翻阅历史、`Esc` 取消生成、`Ctrl+C` 退出

## 安装与运行

```bash
npm install
npm run build
node dist/cli.js
```

需要交互式终端（TTY）。

## 开发

```bash
npm run build   # tsc 编译
npm run dev     # tsc --watch
npm test        # prettier + xo + build + ava
```

## 结构

```
src/
  cli.tsx                  # CLI 入口（参数解析、TTY 检查）
  app.tsx                  # 布局：header / 消息列表 / 输入框 / 提示
  use-chat.ts              # 会话状态与流式生成逻辑
  llm.ts                   # ChatClient 接口 + MockChatClient（占位）
  types.ts                 # Message 类型
  width.ts                 # 估算字符串显示宽度（中英文混排）
  components/
    prompt-input.tsx       # 自定义文本输入框
    message-list.tsx       # 消息列表（自动滚动到最新）
  app.test.tsx             # 测试
```

接入真实模型时，实现 `src/llm.ts` 里的 `ChatClient` 接口即可。
