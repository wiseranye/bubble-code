import type { AskUserInput, QuestionnaireOutcome } from './ask-user-input.ts';

// App 提供的交互能力集合。工具自行声明是否连接 UI，组合根无需了解具体工具。
export interface ToolUi {
  showQuestionnaire(
    input: AskUserInput,
    signal?: AbortSignal,
  ): Promise<QuestionnaireOutcome>;
}
