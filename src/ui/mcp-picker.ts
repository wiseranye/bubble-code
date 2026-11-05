import {
  type Component,
  SelectList,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import type { McpConnection } from '../mcp/manager.ts';
import { selectListTheme, style } from './theme.ts';

const maxVisibleEntries = 8;

export class McpPicker implements Component {
  private readonly byKey: ReadonlyMap<string, McpConnection>;
  private readonly list: SelectList;
  private readonly onChange: () => void;
  private expandedKey: string | undefined;

  constructor(
    entries: readonly McpConnection[],
    onCancel: () => void,
    onChange: () => void,
  ) {
    this.byKey = new Map(entries.map(entry => [connectionKey(entry), entry]));
    this.onChange = onChange;
    this.list = new SelectList(
      entries.map(entry => ({
        value: connectionKey(entry),
        label: `${statusIcon(entry)} ${entry.serverName}`,
        description: `${statusLabel(entry)} · ${entry.cwd}`,
      })),
      Math.max(1, Math.min(maxVisibleEntries, entries.length)),
      selectListTheme,
    );
    this.list.onSelect = item => {
      const entry = this.byKey.get(item.value);
      if (entry?.status !== 'connected') {
        return;
      }
      this.expandedKey =
        this.expandedKey === item.value ? undefined : item.value;
      this.onChange();
    };
    this.list.onSelectionChange = item => {
      if (this.expandedKey !== undefined && this.expandedKey !== item.value) {
        this.expandedKey = undefined;
        this.onChange();
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
    const lines = [
      style.dim('MCP 连接 · Enter 展开/收起工具 · Esc 关闭'),
      ...this.list.render(width),
    ];
    const selected = this.list.getSelectedItem();
    const entry =
      selected === null ? undefined : this.byKey.get(selected.value);
    if (entry === undefined) {
      return lines;
    }

    if (entry.status === 'failed' && entry.error !== undefined) {
      lines.push(
        style.error(truncateToWidth(`失败原因：${entry.error}`, width)),
      );
    }
    if (this.expandedKey !== selected?.value) {
      return lines;
    }

    lines.push(style.dim(`工具列表（${entry.tools.length}）`));
    if (entry.tools.length === 0) {
      lines.push(style.dim('  无工具'));
      return lines;
    }
    for (const tool of entry.tools) {
      lines.push(
        truncateToWidth(`  • ${tool.name} — ${tool.description}`, width),
      );
    }
    return lines;
  }
}

function connectionKey(entry: McpConnection): string {
  return JSON.stringify([entry.cwd, entry.serverName]);
}

function statusIcon(entry: McpConnection): string {
  if (entry.status === 'connected') {
    return '✓';
  }
  return entry.status === 'connecting' ? '◌' : '✗';
}

function statusLabel(entry: McpConnection): string {
  if (entry.status === 'connected') {
    return '已连接';
  }
  return entry.status === 'connecting' ? '连接中' : '连接失败';
}
