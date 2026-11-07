# 并行工具调用与完整结果配对

一条 Assistant Protocol message 的 Tool call 构成独立批次：Tool 通过同步、无副作用的 `isConcurrencySafe(input)` 声明并发安全，首版只检查单次调用而不检测批内资源冲突；`read`、`find`、`grep` 与所有 MCP 工具允许并行，`edit`、`write`、`bash` 不允许，谓词异常或未知工具也使整批按声明顺序串行，以避免部分并行改变副作用顺序。全部安全时按顶层 `maxConcurrentToolCalls` 配置滚动补位，默认每批最多同时执行 10 个且不与 Run 或 ChatSession 共享额度；UI 以 queued / running / done 展示准备、执行与完成状态并按实际完成更新，而协议历史、`turn_end.toolResults` 和持久化保持调用声明顺序，且必须等整批收尾后才能结束 Turn。用户 Abort 或模型流失败时，已启动调用保留实际结果，从未启动的完整调用补齐失败结果并随下一次用户触发的模型请求回传，保证每个已接收 Tool call 恰好有一个结果且不自动恢复已中止的 Run。
