// XO 0.53 内置的 @typescript-eslint v5 与仓库使用的 TypeScript 5.9 不兼容，
// 类型程序解析不了 node_modules 里的类型（外部符号一律退化成 any），
// 下面这些依赖类型信息的规则会大规模误报，故关闭。类型正确性由 tsc 保证。
module.exports = {
  prettier: true,
  rules: {
    'unicorn/expiring-todo-comments': 'off',
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
    '@typescript-eslint/no-redundant-type-constituents': 'off',
    '@typescript-eslint/restrict-template-expressions': 'off',
  },
  overrides: [
    {
      // Shiki 的 exports 映射要求用不带后缀的子路径（shiki/core），
      // 补上 .mjs 反而会丢掉类型声明
      files: ['src/markdown/highlight.ts'],
      rules: {
        'n/file-extension-in-import': 'off',
      },
    },
    {
      // OpenAI 协议字段（tool_calls、tool_call_id、stream_options 等）
      // 是 wire format，必须保持 snake_case
      files: ['src/agent/agent-loop.ts', 'src/model/openai.ts'],
      rules: {
        '@typescript-eslint/naming-convention': 'off',
      },
    },
  ],
};
