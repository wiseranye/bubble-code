# bubble-code

bubble-code 是一个运行在终端里的编码智能体（coding agent）：用户在对话界面里输入需求，Agent 调用模型与工具完成代码任务。

## Language

**Agent**:
负责一轮任务的执行者：把用户输入交给模型，流式产出助手文本，执行工具调用，并维护与模型交换的协议历史。
_Avoid_: Bot、Assistant、Backend

**Protocol message（协议消息）**:
与模型交换的一条消息，只有 role / content / extra 三个字段，不含任何展示概念。
_Avoid_: Chat message

**Chat message（聊天消息）**:
渲染在对话记录里的一条消息，角色为 user / assistant / tool / system，带展示所需的字段（如工具调用的输入、输出、状态）。
_Avoid_: Message、Record

**Transcript（对话记录）**:
按时间顺序排列的 Chat message 列表，是界面上呈现的全部内容。
_Avoid_: History、Log、Messages

**ChatSession（会话）**:
一段对话的状态拥有者：维护 Transcript、接收 Agent 事件流并映射为 Chat message、处理取消与错误，不含任何渲染逻辑。
_Avoid_: ChatController、ViewModel、Store、Conversation

**Sealed（已冻结）**:
一条不再随流式输出变化的 Chat message。冻结之后仍允许用户主动触发的更新（展开/收起工具消息的正文）。
_Avoid_: Finalized、Committed、Closed

**Tool message（工具消息）**:
一条记录单次工具调用的 Chat message：工具名、原始输入、执行输出与状态（running / done）。
_Avoid_: Tool call（那是协议层的记录）

**Context（上下文）**:
一次请求发给模型的全部 Protocol message：system prompt、（如有）最近一次压缩的摘要、保留区间。
_Avoid_: 消息历史、History

**Session file（会话文件）**:
会话的持久化记录：按时间追加的条目序列，恢复会话时重放以重建状态。
_Avoid_: Log

**Compaction（压缩）**:
用模型对较早的 Protocol message 生成摘要、并以摘要替换 Context 前缀的过程，用于降低 token 占用。
_Avoid_: Summarize（摘要只是产物，不是过程）

**Summary（摘要）**:
压缩的产物：一段替代被压缩消息的文本，作为 Context 前缀发送给模型。

**Compaction entry（压缩条目）**:
会话文件中记录一次压缩的条目：包含摘要文本，标识其之前的消息已被摘要取代。
_Avoid_: Summary entry

**Retained tail（保留区间）**:
压缩后完整保留在 Context 末尾的消息区段，不参与摘要。
