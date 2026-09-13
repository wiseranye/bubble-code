export type ToolInputParseResult =
  | {
      ok: true;
      value: Record<string, unknown>;
    }
  | {
      ok: false;
      error: Error;
      raw: string;
    };

export function parseToolInput(input: string): ToolInputParseResult {
  try {
    const value: unknown = JSON.parse(input);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return {
        ok: false,
        error: new Error('Tool input must be a JSON object'),
        raw: input,
      };
    }

    return {
      ok: true,
      value: value as Record<string, unknown>,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
      raw: input,
    };
  }
}
