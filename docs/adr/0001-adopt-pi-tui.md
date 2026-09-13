# 用 pi-tui 替换 Ink 作为终端渲染层

Ink 的差分渲染在主屏模式下对"帧高超过终端"的处理需要大量绕行（按行裁剪 live 区域、`<Static>` 定稿、手工宽度/高度估算），自研输入框与 markdown 渲染器也持续承担维护成本。我们改用 `@earendil-works/pi-tui`（命令式组件、差分渲染、CSI 2026 同步输出）：主屏渲染器 `TuiMainScreen` 保留终端 scrollback，交互形态不变；输入框直接用其 `Editor`，助手消息用其 `Markdown`（通过 `highlightCode` 钩子继续接 shiki，收尾时 settle 再冻结）。

**考虑过的选项**：保留 Ink 并继续打补丁；用 `TuiAltScreen` 全屏模式（有鼠标滚动/选择/搜索，但交互变化大，推迟为独立决策）；把自研输入框/markdown 渲染器移植到 pi-tui（保留最多自研代码，但放弃 Editor 的 IME/粘贴/历史能力）。

**后果**：需要 Node >=22.19（原为 >=18.19）；React/ink 及其测试库、cli-truncate、wrap-ansi、marked-shiki 等依赖移除；"消息完成后不再修改"仍是硬纪律——pi-tui 主屏若检测到视口上方行变化，会清屏、清 scrollback 并整卷重打。
