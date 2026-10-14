/** 拆分 UTF-8 BOM 与正文，写回文件时再拼回，保证 BOM 不丢失 */
export function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content };
}
