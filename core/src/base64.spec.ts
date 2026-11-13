import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from './base64.ts';

const samples = [0, 1, 2, 3, 4, 5, 255, 256, 1000].map((length) =>
  Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff),
);

describe('encodeBase64', () => {
  it('matches Node base64, with padding', () => {
    for (const bytes of samples) {
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('matches Node base64url, with no padding, when url is true', () => {
    for (const bytes of samples) {
      expect(encodeBase64(bytes, true)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });
});

describe('decodeBase64', () => {
  it('reverses both encodings', () => {
    for (const bytes of samples) {
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
      expect(decodeBase64(encodeBase64(bytes, true))).toEqual(bytes);
    }
  });

  it('returns null for text that is not base64', () => {
    expect(decodeBase64('a')).toBeNull();
    expect(decodeBase64('ab!d')).toBeNull();
  });
});
