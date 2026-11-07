import { askUserInputSchema } from './ask-user-input.ts';
import { summariseUnknownInput } from './summarise-input.ts';
import type { ToolRenderer, ToolRenderState } from './types.ts';

export const askUserRenderer: ToolRenderer = {
  summarise,
  activity,
};

function summarise(input: unknown): string {
  const parsed = askUserInputSchema.safeParse(input);
  if (!parsed.success) {
    return summariseUnknownInput(input);
  }
  return parsed.data.questions.map(question => question.title).join(' / ');
}

function activity(state: ToolRenderState): string | undefined {
  return state.status === 'running' ? '等待用户回答…' : undefined;
}
