import * as z from 'zod';

// 编辑文件输入
export const editInputSchema = z.object({
  filePath: z.string().meta({
    description: 'The file path to edit (relative or absolute)',
  }),
  oldText: z.string().meta({
    description:
      'Literal text to replace. Must match exactly. Line ending differences and minor unicode variants (smart quotes, dashes, trailing whitespace) are tolerated.',
  }),
  newText: z.string().meta({
    description:
      'Literal replacement text. Use an empty string to delete the match.',
  }),
  replaceAll: z.optional(
    z.boolean().meta({
      description:
        'Replace all matches. Defaults to false, oldText must appear exactly once.',
    }),
  ),
});

export type EditInput = z.infer<typeof editInputSchema>;
