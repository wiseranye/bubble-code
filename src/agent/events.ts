// Agent 事件
export type AgentEvent =
  | {type: 'thinking_start'; text: string}
  | {type: 'thinking_delta'; text: string}
  | {type: 'thinking_end'}
  | {type: 'assistant_start'; text: string}
  | {type: 'assistant_delta'; text: string}
  | {type: 'assistant_end'}
  | {type: 'tool_start'; tool_call_id: string; name: string; input: string}
  | {
      type: 'tool_result';
      tool_call_id: string;
      name: string;
      output: string;
      success: boolean;
    }
  | {type: 'tool_end'; tool_call_id: string}
  | {type: 'error'; error: Error}
  | {type: 'complete'; output: string};
