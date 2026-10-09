import { expect, it } from 'vitest';
import { uuidv7 } from '../../src/utils/uuid.ts';

it('uuid', () => {
  expect(uuidv7()).toHaveLength(36);
});
