// Approximate the visual width of a string, counting CJK and full-width
// characters as two columns. This is used to estimate how many terminal rows
// a message occupies so we can keep the latest messages on screen.
const wideCharacter =
  /[\u1100-\u115F\u2E80-\u303E\u3040-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE1F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export function stringWidth(input: string): number {
  let width = 0;
  for (const character of input) {
    width += wideCharacter.test(character) ? 2 : 1;
  }

  return width;
}
