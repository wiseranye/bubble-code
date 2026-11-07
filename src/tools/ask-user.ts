import { askUserRenderer } from './ask-user.render.ts';
import {
  type AskUserInput,
  askUserInputSchema,
  type QuestionAnswer,
} from './ask-user-input.ts';
import { defineTool } from './schema.ts';
import type { ToolResult } from './types.ts';
import type { ToolUi } from './ui.ts';

export function createAskUserTool() {
  let ui: ToolUi | undefined;
  return defineTool({
    name: 'ask_user',
    description: `Ask the user one or more questions when information required to proceed is missing or a decision belongs to the user. Put all related questions in one call. Do not use this for facts that can be found with other tools. Every question needs at least two preset options; the user can also enter a custom answer.`,
    inputSchema: askUserInputSchema,
    render: askUserRenderer,
    connectUi: nextUi => {
      ui = nextUi;
    },
    isConcurrencySafe: () => false,
    async execute(input: AskUserInput, context): Promise<ToolResult> {
      if (context.signal?.aborted) {
        return { success: false, output: '', error: 'user aborted' };
      }
      const currentUi = ui;
      if (currentUi === undefined) {
        return {
          success: false,
          output: '',
          error: '交互式提问尚未连接到用户界面',
        };
      }
      try {
        const outcome = await currentUi.showQuestionnaire(
          input,
          context.signal,
        );
        switch (outcome.status) {
          case 'submitted':
            return {
              success: true,
              output: formatQuestionnaireAnswers(input, outcome.answers),
            };
          case 'cancelled':
            return {
              success: false,
              output: '',
              error: '用户取消了回答',
            };
          case 'aborted':
            return { success: false, output: '', error: 'user aborted' };
        }
      } catch (error: unknown) {
        return {
          success: false,
          output: '',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

export function formatQuestionnaireAnswers(
  input: AskUserInput,
  answers: readonly QuestionAnswer[],
): string {
  const sections = input.questions.map((question, index) => {
    const values = answers[index]?.values ?? [];
    const answer = formatAnswer(values);
    return `问题 ${index + 1}：${question.question}\n${answer}`;
  });
  return ['用户回答了你的问题：', ...sections].join('\n\n');
}

function formatAnswer(values: readonly string[]): string {
  if (values.length === 1 && !values[0]?.includes('\n')) {
    return `回答：${values[0]}`;
  }

  const lines = values.flatMap(value => {
    const [first = '', ...rest] = value.split('\n');
    return [`- ${first}`, ...rest.map(line => `  ${line}`)];
  });
  return ['回答：', ...lines].join('\n');
}
