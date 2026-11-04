import { describe, expect, it } from 'vitest';
import { utf8ByteLength } from './utf8.ts';

describe('utf8ByteLength', () => {
  it('counts the bytes TextEncoder would write', () => {
    for (const text of ['', 'hi', 'é', '€', '😀', 'a😀é€', '\ud800', 'x\udc00y', '\ud83d']) {
      expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).byteLength);
    }
  });
});
