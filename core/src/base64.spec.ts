import { describe, expect, it, vi } from 'vitest';
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

  it('encodes a view into a larger buffer by its own bytes only', () => {
    const whole = Uint8Array.from({ length: 20 }, (_, i) => i);
    expect(encodeBase64(whole.subarray(5, 12))).toBe(
      Buffer.from(whole.subarray(5, 12)).toString('base64'),
    );
  });

  // Browsers have no `Buffer`, so they use the encoder written in JavaScript.
  it('encodes a view of a transferred buffer as empty text', () => {
    const bytes = new Uint8Array(8);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });

    expect(encodeBase64(bytes)).toBe('');
    expect(encodeBase64(bytes, true)).toBe('');
  });

  it('encodes the same with no Buffer', async () => {
    vi.stubGlobal('Buffer', undefined);
    vi.resetModules();
    try {
      const fresh = await import('./base64.ts');
      for (const bytes of samples) {
        expect(fresh.encodeBase64(bytes)).toBe(encodeBase64(bytes));
        expect(fresh.encodeBase64(bytes, true)).toBe(encodeBase64(bytes, true));
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Bundlers and React Native add the `buffer` package as a global Buffer, and it has no base64url.
  it('encodes base64url where a global Buffer is a polyfill with no base64url', async () => {
    const NodeBuffer = Buffer;
    vi.stubGlobal('Buffer', {
      isEncoding: (encoding: string) => encoding === 'base64',
      from: (buffer: ArrayBuffer, offset: number, length: number) => ({
        toString(encoding: string) {
          if (encoding !== 'base64') throw new TypeError(`Unknown encoding: ${encoding}`);

          return NodeBuffer.from(buffer, offset, length).toString(encoding);
        },
      }),
    });
    vi.resetModules();
    try {
      const fresh = await import('./base64.ts');
      for (const bytes of samples) {
        expect(fresh.encodeBase64(bytes, true)).toBe(encodeBase64(bytes, true));
      }
    } finally {
      vi.unstubAllGlobals();
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
    expect(decodeBase64('abé=')).toBeNull();
    expect(decodeBase64('ab=d')).toBeNull();
  });

  it.each(['=', '==', 'AAAA=', 'AAAA==', 'AA=', 'AAA=='])(
    'refuses %j, whose padding does not end a 4-character group',
    (encoded) => {
      expect(decodeBase64(encoded)).toBeNull();
    },
  );

  it('decodes padding that ends the last 4-character group', () => {
    expect(decodeBase64('AA==')).toEqual(new Uint8Array([0]));
    expect(decodeBase64('AAA=')).toEqual(new Uint8Array([0, 0]));
  });

  it('decodes an empty string to no bytes', () => {
    expect(decodeBase64('')).toEqual(new Uint8Array(0));
  });

  // React Native 0.87 and older have no TextDecoder, and the token subprotocol encodes on every connect.
  it('loads and encodes on a platform with no TextDecoder', async () => {
    vi.stubGlobal('TextDecoder', undefined);
    vi.resetModules();
    try {
      const fresh = await import('./base64.ts');
      const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i & 0xff);

      expect(fresh.encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('round-trips a large message with every byte value', () => {
    const bytes = Uint8Array.from({ length: 300_001 }, (_, i) => (i * 131) & 0xff);

    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(decodeBase64(encodeBase64(bytes, true))).toEqual(bytes);
  });
});
