import * as z from 'zod';

export const questionOptionSchema = z.object({
  label: z.string().min(1).meta({ description: 'The answer option label' }),
  description: z.optional(
    z.string().meta({ description: 'Optional explanation of this option' }),
  ),
});

export const questionSchema = z.object({
  title: z.string().min(1).meta({
    description: 'Short title shown in the question tab',
  }),
  question: z.string().min(1).meta({
    description: 'The complete question shown to the user',
  }),
  multiSelect: z.optional(
    z.boolean().meta({
      description:
        'Whether the user may select multiple answers. Defaults to false',
    }),
  ),
  options: z.array(questionOptionSchema).min(2).meta({
    description: 'At least two preset answer options',
  }),
});

export const askUserInputSchema = z.object({
  questions: z.array(questionSchema).min(1).meta({
    description: 'All related questions to ask in one interaction',
  }),
});

export type QuestionOption = z.infer<typeof questionOptionSchema>;
export type Question = z.infer<typeof questionSchema>;
export type AskUserInput = z.infer<typeof askUserInputSchema>;

export interface QuestionAnswer {
  // 预设选项保持声明顺序，自定义答案位于最后。
  readonly values: readonly string[];
}

export type QuestionnaireOutcome =
  | {
      readonly status: 'submitted';
      readonly answers: readonly QuestionAnswer[];
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'aborted' };
