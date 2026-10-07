const shared = require('@vdemedes/prettier-config');

module.exports = {
  ...shared,
  useTabs: false,
  tabWidth: 2,
  bracketSpacing: true,
  // import 排序：node 内置 -> 第三方 -> 相对路径，组内按模块路径字母序
  plugins: [require.resolve('@ianvs/prettier-plugin-sort-imports')],
  importOrder: ['<BUILTIN_MODULES>', '<THIRD_PARTY_MODULES>', '^[.]'],
  importOrderCaseSensitive: false,
};
