import { describe, expect, it } from 'vitest';
import { isValidCloseCode } from './close-code.ts';

describe('isValidCloseCode', () => {
  it.each([1000, 1001, 1014, 3000, 4000, 4999])('accepts %s', (code) => {
    expect(isValidCloseCode(code)).toBe(true);
  });

  it.each([999, 1004, 1005, 1006, 1015, 2999, 5000, 4000.5, Number.NaN, Infinity])(
    'rejects %s',
    (code) => {
      expect(isValidCloseCode(code)).toBe(false);
    },
  );
});
