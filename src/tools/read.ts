// import { open, readFile } from 'fs/promises'
// import { createInterface } from 'readline/promises';
// import { Tool, ToolResult } from './tool.js';

// export type ReadInput = {
//   file_path: string;  // 绝对路径
//   limit?: number;     // 读取行数
//   offset?: number;    // 起始行数（1-indexed，内部会转成 0-indexed）
// }

// // 一次最多读取的字符数，超出则报错。
// const maxResultSizeChars = 100_000;

// export const readTool: Tool<ReadInput> = {
//   name: 'read',
//   description: '用于读取文件内容，不适用于二进制文件',
//   inputSchema: {
//     type: 'object',
//     properties: {
//       file_path: {
//         type: 'string',
//         description: '文件绝对路径',
//       },
//       limit: {
//         type: 'number',
//         description: '读取行数',
//         optional: true,
//       },
//       offset: {
//         type: 'number',
//         description: '起始行数（1-indexed，内部会转成 0-indexed）',
//         optional: true,
//       },
//     }
//   },
//   async execute(input): Promise<ToolResult> {
//     try {
//       const content = await readFile(input.file_path, { encoding: 'utf-8' })
//     }
//     return {
//       success: true,
//       output: '',
//     }
//   }

// }
