import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from '@earendil-works/pi-tui';
import {
  createSkillActivation,
  formatSkillActivation,
  type Skill,
  type SkillActivation,
} from '../agent/skills.ts';

// 斜杠命令的展示信息；选中回车后的执行逻辑在 app.ts 的 runSlashCommand
export type SlashCommand = {
  name: string;
  description: string;
  // 有 argumentHint 表示命令带参数：弹层里回车只补全命令名，留给用户继续输入参数
  argumentHint?: string;
  // Skill 的额外描述可省略；rename 等内置命令仍要求填写参数
  argumentOptional?: boolean;
  skill?: Skill;
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

const skillArgumentHint = '额外描述（可选）';

export function slashCommandTakesArgument(name: string): boolean {
  if (name.startsWith('skill:')) {
    return true;
  }
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

  const name = match[1]!;
  if (name.startsWith('skill:')) {
    return `${match[2] === '' ? ' ' : ''}<${skillArgumentHint}>`;
  }

  const command = slashCommands.find(entry => entry.name === name);
  if (command?.argumentHint === undefined) {
    return undefined;
  }

  const gap = match[2] === '' ? ' ' : '';
  return `${gap}<${command.argumentHint}>`;
}

// 行首输入 / 时弹出命令列表。只做命令补全，不做文件路径补全
export class SlashCommandAutocomplete implements AutocompleteProvider {
  private readonly getSkills: () => readonly Skill[];

  constructor(getSkills: () => readonly Skill[] = () => []) {
    this.getSkills = getSkills;
  }

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

    const items: AutocompleteItem[] = allCommands(this.getSkills())
      .filter(command => command.name.startsWith(prefix))
      .map(command => ({
        value: command.name,
        label: command.name,
        // 内置带参命令显示参数提示；Skill 直接展示描述，不重复占用一列。
        description:
          command.skill === undefined && command.argumentHint
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

// Skill 名称即使是非规范的空格形式，也按当前快照里的完整名称优先匹配；
// 其余命令维持第一个词的精确匹配规则。
export function matchSlashCommand(
  text: string,
  skills: readonly Skill[] = [],
): SlashCommandInvocation | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }

  const skillCommands = skills
    .map(toSkillCommand)
    .sort((a, b) => b.name.length - a.name.length);
  for (const command of skillCommands) {
    const prefix = `/${command.name}`;
    if (trimmed === prefix) {
      return { command, argument: '' };
    }
    if (trimmed.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length);
      if (/^\s/.test(rest)) {
        return { command, argument: rest.trim() };
      }
    }
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

export function isSkillSlashCommand(text: string): boolean {
  return text.trim().startsWith('/skill:');
}

export interface SlashSubmissionHandlers {
  readonly skills: readonly Skill[];
  readonly busy: boolean;
  restore(text: string): void;
  notify(content: string): void;
  prompt(text: string, skillActivation?: SkillActivation): void;
  runCommand(invocation: SlashCommandInvocation, text: string): void;
}

// Editor 提交的控制器：Skill 在这里激活，内置命令交回 app 分发。
// 保持输入恢复与通知语义独立于 TUI，便于覆盖未知、忙碌和可选描述场景。
export function submitSlashCommand(
  text: string,
  handlers: SlashSubmissionHandlers,
): void {
  const invocation = matchSlashCommand(text, handlers.skills);
  const skill = invocation?.command.skill;
  if (invocation !== undefined && skill !== undefined) {
    if (handlers.busy) {
      handlers.restore(text);
      handlers.notify('请等待当前会话结束');
      return;
    }

    const activation = createSkillActivation(skill, invocation.argument);
    handlers.prompt(formatSkillActivation(activation), activation);
    return;
  }

  if (invocation !== undefined) {
    if (
      invocation.command.argumentHint !== undefined &&
      invocation.command.argumentOptional !== true &&
      invocation.argument === ''
    ) {
      handlers.restore(`/${invocation.command.name} `);
      return;
    }

    handlers.runCommand(invocation, text);
    return;
  }

  if (isSkillSlashCommand(text)) {
    handlers.restore(text);
    handlers.notify('未找到匹配的 Skill，请从补全列表中选择');
    return;
  }

  handlers.prompt(text);
}

function allCommands(skills: readonly Skill[]): SlashCommand[] {
  return [...slashCommands, ...skills.map(toSkillCommand)];
}

function toSkillCommand(skill: Skill): SlashCommand {
  return {
    name: `skill:${skill.name}`,
    description: skill.description,
    argumentHint: skillArgumentHint,
    argumentOptional: true,
    skill,
  };
}
