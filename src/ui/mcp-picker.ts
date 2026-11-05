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
  private byKey: ReadonlyMap<string, McpConnection>;
  private list: SelectList;
  private readonly getEntries: () => readonly McpConnection[];
  private readonly onCancel: () => void;
  private readonly onChange: () => void;
  private entriesSnapshot: string;
  private expandedKey: string | undefined;

  constructor(
    getEntries: () => readonly McpConnection[],
    onCancel: () => void,
    onChange: () => void,
  ) {
    this.getEntries = getEntries;
    this.onCancel = onCancel;
    this.onChange = onChange;
    const entries = getEntries();
    this.entriesSnapshot = JSON.stringify(entries);
    this.byKey = new Map(entries.map(entry => [connectionKey(entry), entry]));
    this.list = this.createList(entries);
  }

  private createList(entries: readonly McpConnection[]): SelectList {
    const list = new SelectList(
      entries.map(entry => ({
        value: connectionKey(entry),
        label: `${statusIcon(entry)} ${entry.serverName}`,
        description: `${statusLabel(entry)} · ${entry.cwd}`,
      })),
      Math.max(1, Math.min(maxVisibleEntries, entries.length)),
      selectListTheme,
    );
    list.onSelect = item => {
      const entry = this.byKey.get(item.value);
      if (entry?.status !== 'connected') {
        return;
      }
      this.expandedKey =
        this.expandedKey === item.value ? undefined : item.value;
      this.onChange();
    };
    list.onSelectionChange = item => {
      if (this.expandedKey !== undefined && this.expandedKey !== item.value) {
        this.expandedKey = undefined;
        this.onChange();
      }
    };
    list.onCancel = this.onCancel;
    return list;
  }

  private refresh(): void {
    const entries = this.getEntries();
    const snapshot = JSON.stringify(entries);
    if (snapshot === this.entriesSnapshot) {
      return;
    }

    const selectedKey = this.list.getSelectedItem()?.value;
    this.entriesSnapshot = snapshot;
    this.byKey = new Map(entries.map(entry => [connectionKey(entry), entry]));
    this.list = this.createList(entries);
    const selectedIndex = entries.findIndex(
      entry => connectionKey(entry) === selectedKey,
    );
    if (selectedIndex >= 0) {
      this.list.setSelectedIndex(selectedIndex);
    }

    const expandedEntry =
      this.expandedKey === undefined
        ? undefined
        : this.byKey.get(this.expandedKey);
    if (
      expandedEntry?.status !== 'connected' ||
      this.list.getSelectedItem()?.value !== this.expandedKey
    ) {
      this.expandedKey = undefined;
    }
  }

  handleInput(data: string): void {
    this.refresh();
    this.list.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    this.refresh();
    return this.list.handleMouse({ ...event, y: event.y - 1 });
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    this.refresh();
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
