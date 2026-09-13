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
一条不会再被修改的 Chat message。已冻结的消息可以安全地留在终端 scrollback 里；只有未冻结的消息允许更新。
_Avoid_: Finalized、Committed、Closed

**Tool message（工具消息）**:
一条记录单次工具调用的 Chat message：工具名、原始输入、执行输出与状态（running / done）。
_Avoid_: Tool call（那是协议层的记录）
