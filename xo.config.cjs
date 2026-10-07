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
    '@typescript-eslint/restrict-plus-operands': 'off',
    '@typescript-eslint/restrict-template-expressions': 'off',
    // AGENTS.md 要求字段显式声明并在构造函数中赋值，与参数属性简写冲突
    '@typescript-eslint/parameter-properties': 'off',
  },
  overrides: [
    {
      // Shiki 的 exports 映射要求用不带后缀的子路径（shiki/core），
      // 补上 .mjs 反而会丢掉类型声明
      files: ['src/ui/highlight.ts'],
      rules: {
        'n/file-extension-in-import': 'off',
      },
    },
    {
      // OpenAI 协议/SDK 字段(tool_calls、tool_call_id、baseURL、stream_options 等)
      // 是外部命名，必须原样保持
      files: [
        'src/agent/agent-loop.ts',
        'src/model/openai.ts',
        'src/model/openai-completions.ts',
      ],
      rules: {
        '@typescript-eslint/naming-convention': 'off',
      },
    },
    {
      // UUID v7 的字节打包本质就是位运算
      files: ['src/utils/uuid.ts'],
      rules: {
        'no-bitwise': 'off',
      },
    },
  ],
};
