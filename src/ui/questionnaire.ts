import {
  type Component,
  Editor,
  getKeybindings,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type {
  AskUserInput,
  Question,
  QuestionAnswer,
  QuestionnaireOutcome,
} from '../tools/ask-user-input.ts';
import { editorTheme, style } from './theme.ts';

const maxVisibleOptions = 6;
const maxReviewLines = 12;
const maxTabTitleWidth = 18;
const invisibleAnswerCharacters =
  /\p{White_Space}|\u200b|\u200c|\u200d|\u2060|\ufeff/gu;

interface AnswerState {
  readonly selectedOptions: Set<number>;
  customText: string;
  customSelected: boolean;
}

export function hasVisibleAnswer(text: string): boolean {
  return text.replace(invisibleAnswerCharacters, '').length > 0;
}

export function normalizeCustomAnswer(text: string): string {
  return text.trim();
}

// 复合键盘问卷：预设选项和自定义编辑器共享即时答案状态，不引入草稿层。
export class QuestionnaireView implements Component {
  private readonly input: AskUserInput;
  private readonly onFinish: (outcome: QuestionnaireOutcome) => void;
  private readonly requestRender: () => void;
  private readonly answers: AnswerState[];
  private readonly cursors: number[];
  private readonly optionStarts: number[];
  private readonly customEditor: Editor;
  private activeTab: number;
  private tabStart: number;
  private reviewOffset: number;
  private customEditing: boolean;
  private editingQuestion: number | undefined;
  private isFocused: boolean;

  constructor(
    tui: TUI,
    input: AskUserInput,
    onFinish: (outcome: QuestionnaireOutcome) => void,
    requestRender: () => void,
  ) {
    this.input = input;
    this.onFinish = onFinish;
    this.requestRender = requestRender;
    this.answers = input.questions.map(() => ({
      selectedOptions: new Set<number>(),
      customText: '',
      customSelected: false,
    }));
    this.cursors = input.questions.map(() => 0);
    this.optionStarts = input.questions.map(() => 0);
    this.activeTab = 0;
    this.tabStart = 0;
    this.reviewOffset = 0;
    this.customEditing = false;
    this.editingQuestion = undefined;
    this.isFocused = false;
    this.customEditor = new Editor(tui, editorTheme, { paddingX: 2 });
    this.customEditor.onChange = text => {
      const index = this.editingQuestion;
      if (index !== undefined && this.input.questions[index]?.multiSelect) {
        this.answers[index]!.customText = text;
      }
      this.requestRender();
    };
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.syncCustomEditor();
  }

  invalidate(): void {
    this.customEditor.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onFinish({ status: 'cancelled' });
      return;
    }

    this.syncCustomEditor();
    if (this.editingQuestion !== undefined) {
      this.handleCustomInput(data);
      return;
    }
    if (this.hasSubmitTab() && this.activeTab === this.input.questions.length) {
      this.handleReviewInput(data);
      return;
    }
    this.handleOptionInput(data);
  }

  render(width: number): string[] {
    this.syncCustomEditor();
    const safeWidth = Math.max(1, Math.floor(width));
    const lines = [
      style.dim('─'.repeat(safeWidth)),
      this.renderTabs(safeWidth),
      '',
    ];
    if (this.hasSubmitTab() && this.activeTab === this.input.questions.length) {
      lines.push(...this.renderReview(safeWidth));
    } else {
      lines.push(...this.renderQuestion(safeWidth));
    }
    lines.push('', this.renderHint());
    return lines.map(line => truncateToWidth(line, safeWidth));
  }

  private hasSubmitTab(): boolean {
    return this.input.questions.length > 1;
  }

  private currentQuestion(): Question {
    return this.input.questions[this.activeTab]!;
  }

  private itemCount(index: number): number {
    const question = this.input.questions[index]!;
    return (
      question.options.length +
      1 +
      (this.input.questions.length === 1 && question.multiSelect ? 1 : 0)
    );
  }

  private isAnswered(index: number): boolean {
    const question = this.input.questions[index]!;
    const answer = this.answers[index]!;
    return (
      answer.selectedOptions.size > 0 ||
      (question.multiSelect
        ? hasVisibleAnswer(answer.customText)
        : answer.customSelected && hasVisibleAnswer(answer.customText))
    );
  }

  private allAnswered(): boolean {
    return this.input.questions.every((_, index) => this.isAnswered(index));
  }

  private answerValues(index: number): string[] {
    const question = this.input.questions[index]!;
    const answer = this.answers[index]!;
    const values = question.options.flatMap((option, optionIndex) =>
      answer.selectedOptions.has(optionIndex) ? [option.label] : [],
    );
    const includeCustom = question.multiSelect
      ? hasVisibleAnswer(answer.customText)
      : answer.customSelected && hasVisibleAnswer(answer.customText);
    if (includeCustom) {
      values.push(normalizeCustomAnswer(answer.customText));
    }
    return values;
  }

  private submit(): void {
    const answers: QuestionAnswer[] = this.input.questions.map((_, index) => ({
      values: this.answerValues(index),
    }));
    this.onFinish({ status: 'submitted', answers });
  }

  private handleOptionInput(data: string): void {
    const keys = getKeybindings();
    if (matchesKey(data, Key.left)) {
      this.switchTab(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.switchTab(1);
      return;
    }
    if (keys.matches(data, 'tui.select.up')) {
      this.moveOption(-1);
      return;
    }
    if (keys.matches(data, 'tui.select.down')) {
      this.moveOption(1);
      return;
    }

    const confirm = keys.matches(data, 'tui.select.confirm');
    const space = matchesKey(data, Key.space);
    if (!confirm && !space) {
      return;
    }

    const questionIndex = this.activeTab;
    const question = this.currentQuestion();
    const optionIndex = this.cursors[questionIndex]!;
    if (optionIndex < question.options.length) {
      const answer = this.answers[questionIndex]!;
      if (question.multiSelect) {
        if (answer.selectedOptions.has(optionIndex)) {
          answer.selectedOptions.delete(optionIndex);
        } else {
          answer.selectedOptions.add(optionIndex);
        }
        this.requestRender();
      } else if (confirm) {
        answer.selectedOptions.clear();
        answer.selectedOptions.add(optionIndex);
        answer.customSelected = false;
        this.advanceFromQuestion(questionIndex);
      }
      return;
    }

    if (optionIndex === question.options.length) {
      if (confirm && !question.multiSelect) {
        this.customEditing = true;
        this.syncCustomEditor();
        this.requestRender();
      }
      return;
    }

    if (confirm && this.isAnswered(questionIndex)) {
      this.submit();
    }
  }

  private moveOption(delta: number): void {
    const index = this.activeTab;
    this.cursors[index] = Math.max(
      0,
      Math.min(this.itemCount(index) - 1, this.cursors[index]! + delta),
    );
    this.customEditing = false;
    this.syncCustomEditor();
    this.requestRender();
  }

  private switchTab(delta: number): void {
    const lastTab = this.input.questions.length - (this.hasSubmitTab() ? 0 : 1);
    this.activeTab = Math.max(0, Math.min(lastTab, this.activeTab + delta));
    this.customEditing = false;
    this.syncCustomEditor();
    this.requestRender();
  }

  private advanceFromQuestion(index: number): void {
    this.customEditing = false;
    if (this.input.questions.length === 1) {
      if (this.currentQuestion().multiSelect) {
        this.cursors[0] = this.itemCount(0) - 1;
        this.syncCustomEditor();
        this.requestRender();
      } else {
        this.submit();
      }
      return;
    }

    const nextUnanswered = this.input.questions.findIndex(
      (_, questionIndex) =>
        questionIndex > index && !this.isAnswered(questionIndex),
    );
    const fallback = this.input.questions.findIndex(
      (_, questionIndex) => !this.isAnswered(questionIndex),
    );
    const next = nextUnanswered >= 0 ? nextUnanswered : fallback;
    this.activeTab = next >= 0 ? next : this.input.questions.length;
    this.syncCustomEditor();
    this.requestRender();
  }

  private syncCustomEditor(): void {
    const questionIndex = this.activeTab;
    const question = this.input.questions[questionIndex];
    const shouldEdit =
      question !== undefined &&
      this.cursors[questionIndex] === question.options.length &&
      (question.multiSelect === true || this.customEditing);
    if (shouldEdit && this.editingQuestion !== questionIndex) {
      this.editingQuestion = questionIndex;
      this.customEditor.setText(this.answers[questionIndex]!.customText);
    } else if (!shouldEdit) {
      this.editingQuestion = undefined;
    }
    this.customEditor.focused = this.isFocused && shouldEdit;
  }

  private handleCustomInput(data: string): void {
    const keys = getKeybindings();
    // Editor.submitValue 会先清空文本再回调；问卷需要先读取并保留答案。
    if (keys.matches(data, 'tui.input.submit')) {
      this.confirmCustomAnswer();
      return;
    }
    const cursor = this.customEditor.getCursor();
    if (keys.matches(data, 'tui.select.up') && cursor.line === 0) {
      this.leaveCustomEditor(-1);
      return;
    }
    if (
      keys.matches(data, 'tui.select.down') &&
      cursor.line === this.customEditor.getLines().length - 1 &&
      this.cursors[this.activeTab]! < this.itemCount(this.activeTab) - 1
    ) {
      this.leaveCustomEditor(1);
      return;
    }
    this.customEditor.handleInput(data);
  }

  private leaveCustomEditor(delta: number): void {
    this.customEditing = false;
    this.editingQuestion = undefined;
    this.moveOption(delta);
  }

  private confirmCustomAnswer(): void {
    const index = this.editingQuestion;
    if (index === undefined) {
      return;
    }
    const question = this.input.questions[index]!;
    const answer = this.answers[index]!;
    if (!question.multiSelect) {
      const text = this.customEditor.getText();
      if (!hasVisibleAnswer(text)) {
        return;
      }
      answer.customText = normalizeCustomAnswer(text);
      answer.customSelected = true;
      answer.selectedOptions.clear();
    } else if (!this.isAnswered(index)) {
      return;
    }
    this.advanceFromQuestion(index);
  }

  private handleReviewInput(data: string): void {
    const keys = getKeybindings();
    if (matchesKey(data, Key.left)) {
      this.switchTab(-1);
      return;
    }
    if (keys.matches(data, 'tui.select.up')) {
      this.reviewOffset = Math.max(0, this.reviewOffset - 1);
      this.requestRender();
      return;
    }
    if (keys.matches(data, 'tui.select.down')) {
      this.reviewOffset++;
      this.requestRender();
      return;
    }
    if (!keys.matches(data, 'tui.select.confirm')) {
      return;
    }
    if (this.allAnswered()) {
      this.submit();
      return;
    }
    const firstUnanswered = this.input.questions.findIndex(
      (_, index) => !this.isAnswered(index),
    );
    this.activeTab = Math.max(0, firstUnanswered);
    this.syncCustomEditor();
    this.requestRender();
  }

  private renderTabs(width: number): string {
    const tabs = this.input.questions.map((question, index) => ({
      label: `${this.isAnswered(index) ? '■' : '□'} ${question.title}`,
      active: index === this.activeTab,
    }));
    if (this.hasSubmitTab()) {
      tabs.push({
        label: '✓ Submit',
        active: this.activeTab === this.input.questions.length,
      });
    }

    let start = Math.min(this.tabStart, this.activeTab);
    const fits = (first: number): number => {
      let used = 0;
      let end = first;
      while (end < tabs.length) {
        const label = truncateToWidth(tabs[end]!.label, maxTabTitleWidth);
        const nextWidth = visibleWidth(label) + (end === first ? 0 : 2);
        if (end > first && used + nextWidth > width - 8) {
          break;
        }
        used += nextWidth;
        end++;
      }
      return end;
    };
    while (fits(start) <= this.activeTab && start < this.activeTab) {
      start++;
    }
    const end = fits(start);
    this.tabStart = start;
    const content = tabs
      .slice(start, end)
      .map(tab => {
        const label = truncateToWidth(tab.label, maxTabTitleWidth);
        return tab.active
          ? chalk.bgHex('#264456').white(` ${label} `)
          : ` ${label} `;
      })
      .join(' ');
    return `${start > 0 ? '← ' : '  '}${content}${end < tabs.length ? ' →' : ''}`;
  }

  private renderQuestion(width: number): string[] {
    const questionIndex = this.activeTab;
    const question = this.currentQuestion();
    const cursor = this.cursors[questionIndex]!;
    const count = this.itemCount(questionIndex);
    let start = this.optionStarts[questionIndex]!;
    start = Math.min(start, cursor);
    start = Math.max(start, cursor - maxVisibleOptions + 1);
    start = Math.max(0, Math.min(start, count - maxVisibleOptions));
    this.optionStarts[questionIndex] = start;
    const end = Math.min(count, start + maxVisibleOptions);

    const lines = [
      ...wrapTextWithAnsi(chalk.bold(question.question), width),
      '',
    ];
    if (start > 0) {
      lines.push(style.dim('  ↑ 更多选项'));
    }
    for (let index = start; index < end; index++) {
      lines.push(...this.renderOption(questionIndex, index, width));
    }
    if (end < count) {
      lines.push(style.dim('  ↓ 更多选项'));
    }
    return lines;
  }

  private renderOption(
    questionIndex: number,
    optionIndex: number,
    width: number,
  ): string[] {
    const question = this.input.questions[questionIndex]!;
    const answer = this.answers[questionIndex]!;
    const active = this.cursors[questionIndex] === optionIndex;
    const pointer = active ? '›' : ' ';
    let label: string;
    let description: string | undefined;
    if (optionIndex < question.options.length) {
      const option = question.options[optionIndex]!;
      const selected = answer.selectedOptions.has(optionIndex);
      const marker = question.multiSelect
        ? selected
          ? '[x]'
          : '[ ]'
        : `${optionIndex + 1}.`;
      label = `${pointer} ${marker} ${option.label}`;
      description = option.description;
    } else if (optionIndex === question.options.length) {
      const selected = question.multiSelect
        ? hasVisibleAnswer(answer.customText)
        : answer.customSelected;
      const marker = question.multiSelect
        ? selected
          ? '[x]'
          : '[ ]'
        : `${optionIndex + 1}.`;
      label = `${pointer} ${marker} Type something.`;
      description = answer.customText.split('\n')[0] || undefined;
    } else {
      label = `${pointer} Submit answers`;
    }

    const lines = wrapTextWithAnsi(
      active ? chalk.bold.cyan(label) : label,
      width,
    );
    if (description !== undefined) {
      lines.push(...wrapTextWithAnsi(style.dim(`  ${description}`), width));
    }
    if (
      optionIndex === question.options.length &&
      this.editingQuestion === questionIndex
    ) {
      lines.push(...this.customEditor.render(Math.max(1, width - 2)));
    }
    return lines;
  }

  private renderReview(width: number): string[] {
    const review = [chalk.bold.cyan('Review your answers'), ''];
    this.input.questions.forEach((question, index) => {
      review.push(`● ${question.title}`);
      const values = this.answerValues(index);
      if (values.length === 0) {
        review.push(style.dim('  → 未回答'));
      } else {
        for (const value of values) {
          const [first = '', ...rest] = value.split('\n');
          review.push(...wrapTextWithAnsi(`  → ${first}`, width));
          for (const line of rest) {
            review.push(...wrapTextWithAnsi(`    ${line}`, width));
          }
        }
      }
    });

    const maxOffset = Math.max(0, review.length - maxReviewLines);
    this.reviewOffset = Math.max(0, Math.min(this.reviewOffset, maxOffset));
    const shown = review.slice(
      this.reviewOffset,
      this.reviewOffset + maxReviewLines,
    );
    if (this.reviewOffset > 0) {
      shown[0] = style.dim('↑ 更多回答');
    }
    if (this.reviewOffset + maxReviewLines < review.length) {
      shown.push(style.dim('↓ 更多回答'));
    }

    return [
      ...shown,
      '',
      style.dim('─'.repeat(width)),
      '',
      'Ready to submit your answers?',
      chalk.bold.cyan('› 1. Submit answers'),
    ];
  }

  private renderHint(): string {
    return style.dim(
      'Enter 选择/确认 · Space 多选 · ↑↓ 导航 · ←→ 切换 · Shift+Enter 换行 · Esc 取消 · Ctrl+C 中断',
    );
  }
}
