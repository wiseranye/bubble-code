import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from '@earendil-works/pi-tui';

// 斜杠命令的展示信息；选中回车后的执行逻辑在 app.ts 的 runSlashCommand
export type SlashCommand = {
  name: string;
  description: string;
  // 有 argumentHint 表示命令带参数：弹层里回车只补全命令名，留给用户继续输入参数
  argumentHint?: string;
};

export const slashCommands: SlashCommand[] = [
  { name: 'new', description: '创建一个新会话' },
  { name: 'quit', description: '退出' },
  { name: 'resume', description: '恢复已有会话' },
  { name: 'fork', description: '从当前会话新建会话' },
  { name: 'model', description: '切换模型' },
  { name: 'rename', description: '修改当前会话名称', argumentHint: '会话名称' },
  { name: 'compact', description: '压缩当前会话' },
];

export function slashCommandTakesArgument(name: string): boolean {
  const command = slashCommands.find(entry => entry.name === name);
  return command?.argumentHint !== undefined;
}

// 文本恰好是带参数命令的命令名（还没输入参数）时，返回跟在文本后面的占位提示。
// 命令名后面还没空格时提示自带一个空格，保证显示成 "/rename <会话名称>"
export function slashCommandArgumentPlaceholder(
  text: string,
): string | undefined {
  const match = /^\/(\S+)([^\S\n]*)$/.exec(text);
  if (match === null) {
    return undefined;
  }

  const command = slashCommands.find(entry => entry.name === match[1]);
  if (command?.argumentHint === undefined) {
    return undefined;
  }

  const gap = match[2] === '' ? ' ' : '';
  return `${gap}<${command.argumentHint}>`;
}

// 行首输入 / 时弹出命令列表。只做命令补全，不做文件路径补全
export class SlashCommandAutocomplete implements AutocompleteProvider {
  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    // 命令只允许出现在首行行首
    if (cursorLine !== 0) {
      return null;
    }

    const beforeCursor = (lines[cursorLine] ?? '').slice(0, cursorCol);
    if (!beforeCursor.startsWith('/')) {
      return null;
    }

    const prefix = beforeCursor.slice(1);
    // 已输入空格（进入参数区）或路径形式的 / 都不补全
    if (prefix.includes(' ') || prefix.includes('/')) {
      return null;
    }

    const items: AutocompleteItem[] = slashCommands
      .filter(command => command.name.startsWith(prefix))
      .map(command => ({
        value: command.name,
        label: command.name,
        // 带参数的命令把参数提示放在描述前面，比如：rename  会话名称 — 修改当前会话名称
        description: command.argumentHint
          ? `${command.argumentHint} — ${command.description}`
          : command.description,
      }));
    if (items.length === 0) {
      return null;
    }

    // prefix 以 / 开头：Editor 据此使用命令弹层布局，并在回车选中后直接提交
    return { items, prefix: beforeCursor };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    _cursorCol: number,
    item: AutocompleteItem,
    _prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    // 命令没有参数，整行替换成 "/name "
    const newLines = [...lines];
    newLines[cursorLine] = `/${item.value} `;
    return { lines: newLines, cursorLine, cursorCol: item.value.length + 2 };
  }
}

export type SlashCommandInvocation = {
  command: SlashCommand;
  argument: string;
};

// 第一个词是已知命令名才算命令；不带参数的命令只认整条 "/name"，
// 后面跟了内容的视为普通提示词（比如 "/new 一下" 要发给模型）
export function matchSlashCommand(
  text: string,
): SlashCommandInvocation | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }

  const body = trimmed.slice(1);
  const spaceIndex = body.search(/\s/);
  const name = spaceIndex === -1 ? body : body.slice(0, spaceIndex);
  const argument = spaceIndex === -1 ? '' : body.slice(spaceIndex + 1).trim();
  const command = slashCommands.find(entry => entry.name === name);
  if (command === undefined) {
    return undefined;
  }

  if (command.argumentHint === undefined && argument !== '') {
    return undefined;
  }

  return { command, argument };
}
