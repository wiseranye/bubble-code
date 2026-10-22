# ADR-004: 会话压缩：追加压缩条目到会话文件，恢复时按条目投影上下文

- **Status:** Accepted（`beforeRequest` 检查点机制已由 ADR 0005 的钩子机制取代）
- **Date:** 2026-10-21

## 背景

模型的 contextWindow 有限：长会话的协议消息列表持续增长，超过窗口后 API 直接拒绝请求，会话卡死。需要一个压缩机制把较早的消息换成摘要。约束：

- 会话文件是 append-only JSONL，写入经串行队列，恢复时重放重建；不能破坏这一致性假设。
- `tool_call` 与其 `tool_result` 必须成对出现，切点拆散它们会导致 API 400。
- 项目经 pi-ai 对接多家协议（anthropic-messages / openai-completions / openai-responses），system 消息位置的支持不一。
- 单次 run 的工具循环可能很长，只在 run 边界压缩堵不住中途超窗口。

## 决策

- 压缩落盘为会话文件尾部追加的 `compaction` 条目 `{ summary, summarizedCount, firstRetainedEntryId }`，原始消息一律不删。`firstRetainedEntryId` 指向保留区间第一条消息的条目（条目自带 uuidv7），`summarizedCount` 仅供 UI 提示。
- 恢复时以最后一条压缩条目为准投影协议历史：system + 摘要（重新生成带固定前缀的 user 消息）+ 从 `firstRetainedEntryId` 起的保留区间 + 压缩后新增的消息；找不到该 id（文件损坏）则忽略条目、保留全部消息。转录区始终重放全量消息，压缩点插入永久标记。
- 摘要调用是侧信道（`ModelApi.stream` 递归，不带 system prompt 与工具），请求与响应都不进历史；第二次压缩把上一次摘要作为输入合并，被摘要的消息永不回流。
- 用量测量锚定最近一次 `AssistantMessage.usage` 的真实计数，其后消息按字符数/4 估算；阈值（默认 0.8）与保留比例（默认 0.16）相对 contextWindow，settings 顶层可配（`compactThreshold` / `compactRetainRatio`）。
- 检查点在每个 turn 的请求之前（`runAgentLoop` 的 `beforeRequest` 回调，含第一轮），超阈值就地在循环内压缩；`/compact` 手动触发无视阈值，守卫只有 streaming 中拒绝与「刚压缩过且无新消息」；短会话保留预算覆盖全部消息时，回退为只保留最后一轮（摘要到最后一条 user 消息为止）。
- 压缩期间消息区插入「正在压缩上下文」临时行，结束原地更新为结果文案；Esc 可取消，失败/取消不动历史，自动压缩失败后闭锁至新一轮产生真实 usage。

## 后果

### 收益

- append-only 与写入队列不变，旧会话文件（无压缩条目）恢复路径自然兼容。
- 切点用条目 id，自描述、损坏可探测，兜底策略是宁可丢摘要不丢上下文。
- 用户的完整阅读记录（Transcript）不受压缩影响。

### 代价

- `AgentSession` 以 WeakMap 维护消息对象 → 条目 id 的映射，依赖 turn_end 事件与 `state.messages` 持有同一对象引用；run 的 user 消息须提前构造、登记后再传入 `runAgentLoop`。
- 循环内压缩要求 `state.messages` 与 `newMessages` 按对象身份拆分同步，实现复杂度集中在 `compactInternal` 与 `beforeRequest` 回调。
- 新版写出的文件被旧版本读取的行为不保证（项目未发稳定版，可接受）。

### 其他影响

- 摘要模型暂固定为当前会话模型，可配置摘要模型留作待办；摘要指令文案是初版，后续调优。

## 备选方案

### 方案 A: 切点记「被摘要条数」

- 优点：压缩条目少一个字段。
- 缺点：条数依赖条目顺序绝不被扰动，无法探测文件损坏。
- 未选择的原因：id 是自描述引用，找不到时可忽略条目降级为不压缩，条数做不到。

### 方案 B: 物理重写文件，把摘要放在保留区间之前

- 优点：恢复投影规则更简单（摘要天然在最前）。
- 缺点：破坏 append-only 与写入队列的既有一致性假设，原始消息被销毁。
- 未选择的原因：一致性假设与完整阅读记录比投影简洁更重要。

### 方案 C: 摘要放进 system prompt

- 优点：语义上更贴近「背景信息」。
- 缺点：各家协议对 system 消息位置支持不一。
- 未选择的原因：带固定前缀的 user 消息对所有 provider 都安全，且会随历史自然滚动。

### 方案 D: turn 中途只打标，run 结束再压缩

- 优点：不在工具循环内引入压缩，实现最简单。
- 缺点：长工具循环中途就会超窗口，下一个请求直接被 API 拒绝，阈值预留的 20% 余量吸收不了。
- 未选择的原因：循环迭代边界处工具结果已全部落地、条目 id 已登记，没有 in-flight 状态，在 `beforeRequest` 检查并就地压缩是安全的，标记法已否决。
