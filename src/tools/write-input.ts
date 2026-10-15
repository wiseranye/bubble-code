import * as z from 'zod';

export const writeInputSchema = z.object({
  filePath: z.string().meta({
    description: 'The file path to write (relative or absolute)',
  }),
  content: z.string().meta({
    description: 'Content to write to the file',
  }),
});

export type WriteInput = z.infer<typeof writeInputSchema>;
