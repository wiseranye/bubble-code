import {
  type Component,
  SelectList,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import type { ModelChoice } from '../llm/model-catalog.ts';
import { selectListTheme, style } from './theme.ts';

// 列表最多同时显示的行数，超出滚动
const maxVisibleEntries = 10;

// provider 名全局唯一、model id 在 provider 内唯一（settings schema 校验保证）
function choiceKey(choice: ModelChoice): string {
  return `${choice.provider.name}/${choice.model.id}`;
}

// /model 的模型选择弹窗：标题行 + 模型列表，Enter 选中，Esc / Ctrl+C 取消。
// 结构同 SessionPicker；鼠标事件的 y 坐标要减掉标题行
export class ModelPicker implements Component {
  private readonly list: SelectList;

  constructor(
    choices: readonly ModelChoice[],
    current: ModelChoice | undefined,
    onSelect: (choice: ModelChoice) => void,
    onCancel: () => void,
  ) {
    const byKey = new Map(choices.map(choice => [choiceKey(choice), choice]));
    const currentKey = current === undefined ? undefined : choiceKey(current);
    this.list = new SelectList(
      choices.map(choice => ({
        value: choiceKey(choice),
        // 当前选中项加 ● 前缀
        label:
          choiceKey(choice) === currentKey
            ? `● ${choice.model.name ?? choice.model.id}`
            : (choice.model.name ?? choice.model.id),
        description: choice.provider.name,
      })),
      Math.min(maxVisibleEntries, choices.length),
      selectListTheme,
    );
    this.list.onSelect = item => {
      const choice = byKey.get(item.value);
      if (choice !== undefined) {
        onSelect(choice);
      }
    };
    this.list.onCancel = onCancel;
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.list.handleMouse({ ...event, y: event.y - 1 });
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    return [
      style.dim('切换模型 · Enter 选中 · Esc 取消'),
      ...this.list.render(width),
    ];
  }
}
