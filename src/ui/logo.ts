import type { Component } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { readVersion } from '../utils/version.ts';
import { style } from './theme.ts';

// 像素点阵：# 是一个像素，统一 6 行高。
// 终端字符格的高约是宽的两倍，一个字符一个像素会把图案纵向拉长，
// 所以渲染时用半块字符（▀/▄）把两行像素压进一个字符格，像素就近似方形
const glyphs: Record<string, string[]> = {
  b: ['#   ', '#   ', '### ', '#  #', '#  #', '### '],
  u: ['    ', '    ', '#  #', '#  #', '#  #', '####'],
  l: ['##', '##', '##', '##', '##', '##'],
  e: ['    ', '    ', ' ## ', '####', '#   ', ' ## '],
  // ›_ 提示符
  prompt: ['      ', '#     ', ' #    ', '  #   ', ' #    ', '#  ###'],
  // 右侧一大一小两个像素泡泡
  bubbleBig: [' ### ', '#   #', '#   #', '#   #', ' ### ', '     '],
  bubbleSmall: ['  ', '  ', '  ', '  ', '##', '##'],
};

// 三段渐变：cyan → blue → purple（和参考图一致）
const gradientStops: Array<[number, number, number]> = [
  [53, 215, 255],
  [82, 137, 255],
  [168, 85, 247],
];

// t ∈ [0,1]，先定位到相邻两个色标，再在段内线性插值
function sampleGradient(t: number): [number, number, number] {
  const scaled = t * (gradientStops.length - 1);
  const segment = Math.min(Math.floor(scaled), gradientStops.length - 2);
  const localT = scaled - segment;
  const from = gradientStops[segment]!;
  const to = gradientStops[segment + 1]!;
  return [
    Math.round(from[0] + (to[0] - from[0]) * localT),
    Math.round(from[1] + (to[1] - from[1]) * localT),
    Math.round(from[2] + (to[2] - from[2]) * localT),
  ];
}

// 两行像素合成一行终端字符：上下都有用 █，只上有 ▀，只下有 ▄，都没有是空格
function renderPixelRows(pixelRows: string[]): string[] {
  const lines: string[] = [];
  for (let row = 0; row < pixelRows.length; row += 2) {
    const top = pixelRows[row]!;
    const bottom = pixelRows[row + 1] ?? '';
    let line = '';
    for (let column = 0; column < top.length; column++) {
      const topSet = top[column] === '#';
      const bottomSet = bottom[column] === '#';
      line += topSet && bottomSet ? '█' : topSet ? '▀' : bottomSet ? '▄' : ' ';
    }

    lines.push(line);
  }

  return lines;
}

// 拼出 6 行像素 LOGO：›_ + bubble + 两个泡泡
function composePixelRows(): string[] {
  const word = ['b', 'u', 'b', 'b', 'l', 'e'];
  const rows: string[] = [];
  for (let row = 0; row < 6; row++) {
    const wordPart = word.map(letter => glyphs[letter]![row]!).join(' ');
    const bubbles = `${glyphs.bubbleBig![row]!} ${glyphs.bubbleSmall![row]!}`;
    rows.push(`${glyphs.prompt![row]!}  ${wordPart}  ${bubbles}`);
  }

  const width = Math.max(...rows.map(row => row.length));
  return rows.map(row => row.padEnd(width));
}

// 横向渐变：按列取色，空格不上色（背景保持透明）
function gradientLine(line: string): string {
  if (chalk.level < 3) {
    // 非 truecolor 终端渐变会糊成色块，退回单色
    return style.logo(line);
  }

  const last = Math.max(line.length - 1, 1);
  let out = '';
  for (let column = 0; column < line.length; column++) {
    const char = line[column]!;
    if (char === ' ') {
      out += char;
      continue;
    }

    const [r, g, b] = sampleGradient(column / last);
    out += chalk.rgb(r, g, b)(char);
  }

  return out;
}

// 主要快捷键，底部提示行有完整版，这里只放最常用的
const hintLine1: Array<[string, string]> = [
  ['Enter', '发送'],
  ['Shift+Enter', '换行'],
];
const hintLine2: Array<[string, string]> = [
  ['/', '命令'],
  ['Esc', '取消'],
  ['Ctrl+C', '退出'],
];

function renderHints(pairs: Array<[string, string]>): string {
  return pairs
    .map(
      ([key, description]) =>
        `${style.prompt(key)}${style.dim(` ${description}`)}`,
    )
    .join(style.dim(' · '));
}

const logoRows = renderPixelRows(composePixelRows());
// 像素 LOGO 宽度；右列（版本 + 快捷键，含 CJK 双宽字符）大约再占 35 列
const logoWidth = logoRows[0]!.length;
const fullWidth = logoWidth + 4 + 31;

// 启动横幅：像素字标在左，版本号和快捷键在右；宽度不够时逐级降级
export class LogoBanner implements Component {
  private readonly version = readVersion();

  invalidate(): void {
    // 内容固定，没有缓存需要清
  }

  render(width: number): string[] {
    if (width < logoWidth + 2) {
      const version = this.version === undefined ? '' : ` v${this.version}`;
      return [`${style.logo('○ Bubble Code')}${style.dim(version)}`, ''];
    }

    const lines = logoRows.map(row => gradientLine(row));

    if (width >= fullWidth) {
      this.mergeRightColumn(lines);
    }

    // 标语缩进到字标左缘（跳过 ›_ 提示符的宽度）
    lines.push(`${' '.repeat(8)}${style.dim('Your Coding Agent')}`);
    lines.push('');
    return lines;
  }

  // 右列对齐到字标的三行：版本号、两行快捷键
  private mergeRightColumn(logoLines: string[]): void {
    const right = [
      style.dim(this.version === undefined ? '' : `v${this.version}`),
      renderHints(hintLine1),
      renderHints(hintLine2),
    ];

    for (const [index, rightLine] of right.entries()) {
      logoLines[index] = `${gradientLine(logoRows[index]!)}    ${rightLine}`;
    }
  }
}
