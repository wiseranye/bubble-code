import {
  type Component,
  SelectList,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import type { SessionFileEntry } from '../agent/session-manager.ts';
import { selectListTheme, style } from './theme.ts';

// 列表最多同时显示的行数，超出滚动
const maxVisibleEntries = 10;

// /resume 的会话选择弹窗：标题行 + 会话列表，Enter 选中，Esc / Ctrl+C 取消。
// 键盘和鼠标都委托给 SelectList；鼠标事件的 y 坐标要减掉标题行
export class SessionPicker implements Component {
  private readonly list: SelectList;

  constructor(
    entries: SessionFileEntry[],
    onSelect: (entry: SessionFileEntry) => void,
    onCancel: () => void,
  ) {
    const byPath = new Map(entries.map(entry => [entry.filePath, entry]));
    this.list = new SelectList(
      entries.map(entry => ({
        value: entry.filePath,
        label: entry.title,
        description: formatTimestamp(entry.timestamp),
      })),
      Math.min(maxVisibleEntries, entries.length),
      selectListTheme,
    );
    this.list.onSelect = item => {
      const entry = byPath.get(item.value);
      if (entry !== undefined) {
        onSelect(entry);
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
      style.dim('恢复会话 · Enter 选中 · Esc 取消'),
      ...this.list.render(width),
    ];
  }
}

function formatTimestamp(timestamp: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
