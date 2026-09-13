import React, {useCallback, useRef, useState} from 'react';
import {Box, Text, useInput, useStdout, type Key} from 'ink';
import {stringWidth} from '../utils/width.js';

type Props = {
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
  readonly isDisabled: boolean;
};

// 输入状态
type InputState = {
  value: string;
  cursor: number;
  history: string[];
  historyIndex: number;
};

export default function Input({onSubmit, onCancel, isDisabled}: Props) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);

  // React的state更新时异步批处理的，这里用state保存输入框真正的数据，
  // 避免快速连按几个键（或粘贴一段文本），在重新渲染之前，导致后面的按键覆盖前面的。
  // 这里用useRef可以保证下一个按键读到的是最新值，不会丢字。
  const state = useRef<InputState>({
    value: '',
    cursor: 0,
    history: [],
    historyIndex: -1,
  });

  // 根据state中的内容触发一次重新渲染
  const sync = useCallback(() => {
    setValue(state.current.value);
    setCursor(state.current.cursor);
  }, []);

  // 这是唯一的修改入口：先改ref再sync触发渲染。
  // 所有编辑操作最后都走它，保证逻辑态和渲染态始终一致。
  const apply = useCallback(
    (nextValue: string, nextCursor: number) => {
      state.current.value = nextValue;
      state.current.cursor = nextCursor;
      sync();
    },
    [sync],
  );

  // 在光标处插入文字
  // 粘贴多字符、Shift+Enter换行、普通打字，都走这里。
  const insert = useCallback(
    (text: string) => {
      const {current} = state;
      apply(
        // 将字符串拆成「光标前 + 光标后」，把新文字夹在中间，光标右移。
        current.value.slice(0, current.cursor) +
          text +
          current.value.slice(current.cursor),
        current.cursor + text.length,
      );
    },
    [apply],
  );

  // 退格
  const removeBefore = useCallback(() => {
    const {current} = state;
    if (current.cursor === 0) {
      return;
    }

    apply(
      current.value.slice(0, current.cursor - 1) +
        current.value.slice(current.cursor),
      current.cursor - 1,
    );
  }, [apply]);

  // 删一个词（Ctrl+W）
  const removeWord = useCallback(() => {
    const {current} = state;
    const head = current.value.slice(0, current.cursor);
    const trimmed = head.replace(/\S+\s*$/u, '');
    apply(trimmed + current.value.slice(current.cursor), trimmed.length);
  }, [apply]);

  // 上下翻历史
  const recall = useCallback(
    (direction: -1 | 1) => {
      const {current} = state;
      if (current.history.length === 0) {
        return;
      }

      let next: number;
      if (current.historyIndex === -1) {
        next = direction === -1 ? current.history.length - 1 : -1;
      } else {
        next = Math.min(
          current.history.length - 1,
          Math.max(-1, current.historyIndex + direction),
        );
      }

      current.historyIndex = next;

      if (next === -1) {
        apply('', 0);
      } else {
        const text = current.history[next] ?? '';
        apply(text, text.length);
      }
    },
    [apply],
  );

  // 回车发送消息
  const submit = useCallback(() => {
    const text = state.current.value.trim();
    if (text === '') {
      return;
    }

    state.current.history = [...state.current.history, state.current.value];
    state.current.historyIndex = -1;
    onSubmit(text);
    apply('', 0);
  }, [onSubmit, apply]);

  const handleEditingKey = useCallback(
    (input: string, key: Key): boolean => {
      if (key.upArrow) {
        recall(-1);
        return true;
      }

      if (key.downArrow) {
        recall(1);
        return true;
      }

      if (key.leftArrow) {
        apply(state.current.value, Math.max(0, state.current.cursor - 1));
        return true;
      }

      if (key.rightArrow) {
        apply(
          state.current.value,
          Math.min(state.current.value.length, state.current.cursor + 1),
        );
        return true;
      }

      if (key.ctrl && input === 'a') {
        apply(state.current.value, 0);
        return true;
      }

      if (key.ctrl && input === 'e') {
        apply(state.current.value, state.current.value.length);
        return true;
      }

      if (key.ctrl && input === 'u') {
        apply('', 0);
        return true;
      }

      if (key.ctrl && input === 'w') {
        removeWord();
        return true;
      }

      if (key.backspace || key.delete) {
        // Ink maps the Backspace key (`\x7f`) to `key.delete` (not
        // `key.backspace`) on most terminals, so treat both as deleting
        // the character before the cursor.
        removeBefore();
        return true;
      }

      return false;
    },
    [apply, recall, removeBefore, removeWord],
  );

  const handleInput = useCallback(
    (input: string, key: Key) => {
      if (key.return) {
        if (key.shift) {
          insert('\n');
        } else if (!isDisabled) {
          submit();
        }

        return;
      }

      if (key.escape) {
        if (isDisabled) {
          onCancel();
        } else {
          apply('', 0);
        }

        return;
      }

      if (handleEditingKey(input, key)) {
        return;
      }

      if (input !== '') {
        insert(input);
      }
    },
    [isDisabled, onCancel, apply, insert, submit, handleEditingKey],
  );

  useInput(handleInput);

  const {stdout} = useStdout();
  // "❯ " 占 2 列，左侧省略号占 1 列；输入框固定一行，
  // 一旦它把实时区域撑得比屏幕还高，Ink 就会清屏重写（画面重复）
  const width = Math.max(4, (stdout.columns ?? 80) - 3);
  const window = inputWindow(value.replace(/\n/g, newlineMark), cursor, width);

  const beforeCursor = window.text.slice(0, window.cursor);
  const afterCursor = window.text.slice(window.cursor);
  const cursorCharacter =
    afterCursor.slice(0, 1) === '' ? ' ' : afterCursor[0]!;

  return (
    <Box>
      <Box flexShrink={0}>
        <Text bold color="cyan">
          ❯
        </Text>
        <Text> </Text>
      </Box>
      <Text wrap="truncate">
        {window.hiddenHead ? <Text dimColor>…</Text> : null}
        <Text>{beforeCursor}</Text>
        <Text inverse>{cursorCharacter}</Text>
        <Text>{afterCursor.slice(cursorCharacter.length)}</Text>
      </Text>
    </Box>
  );
}

// 换行在输入框里显示成 ↵（固定一行显示，换行由标记表示）
const newlineMark = '↵';

type InputWindow = {
  text: string;
  // 光标在 text 里的下标
  cursor: number;
  hiddenHead: boolean;
};

// 横向开窗：保证光标可见（和 shell 一样），并自己按列截断。
// 不能只靠 Ink 的 wrap="truncate"：容器分配宽度不精确时它不会截
function inputWindow(text: string, cursor: number, width: number): InputWindow {
  const headWidth = stringWidth(text.slice(0, cursor));
  // 左右各留一列给省略号
  const hiddenHead = headWidth >= width - 1;
  const body = Math.max(1, width - (hiddenHead ? 1 : 0) - 1);

  let start = 0;
  let columns = headWidth;
  while (start < cursor && columns > body - 1) {
    columns -= stringWidth(text[start] ?? '');
    start += 1;
  }

  // columns 是从 start 累加到光标的宽度，接着从光标往后再补
  let end = cursor;
  while (end < text.length && columns + stringWidth(text[end] ?? '') <= body) {
    columns += stringWidth(text[end] ?? '');
    end += 1;
  }

  const hiddenTail = end < text.length;
  return {
    text: text.slice(start, end) + (hiddenTail ? '…' : ''),
    cursor: cursor - start,
    hiddenHead,
  };
}
