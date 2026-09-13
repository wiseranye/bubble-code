import React, {useCallback, useRef, useState} from 'react';
import {Box, Text, useInput, type Key} from 'ink';

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

  const cursorCharacter = value[cursor] ?? ' ';
  const beforeCursor = value.slice(0, cursor);
  const afterCursor = value.slice(cursor + 1);

  return (
    <Box>
      <Text bold color="cyan">
        ❯
      </Text>
      <Text> </Text>
      <Text>{beforeCursor}</Text>
      <Text inverse>{cursorCharacter}</Text>
      <Text>{afterCursor}</Text>
    </Box>
  );
}
