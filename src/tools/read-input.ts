import * as z from 'zod';

export const readInputSchema = z.object({
  filePath: z
    .string()
    .meta({ description: '文件路径（相对当前工作目录的路径/绝对路径）' }),
  limit: z
    .number()
    .meta({
      description:
        '最大读取行数,不传则读所有;如果传了 offset 没传 limit 则读取从 offset 开始的所有行',
    })
    .optional(),
  offset: z
    .number()
    .meta({
      description: '读取的起始行数（从 1 开始），不传则默认从第一行开始读',
    })
    .optional(),
});

export type ReadInput = z.infer<typeof readInputSchema>;
