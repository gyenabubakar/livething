import { describe, expect, it } from 'vitest';
import {
  decodeBase64Url,
  encodeBase64Url,
  isLiveThingSubprotocol,
  tokenSubprotocols,
} from './subprotocol.ts';

describe('encodeBase64Url', () => {
  it('matches Node base64url, with no padding', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'eyJhbGciOi.x_y-z', 'çé 🙂 ✓', '\u0000ÿ']) {
      expect(encodeBase64Url(text)).toBe(Buffer.from(text, 'utf8').toString('base64url'));
    }
  });

  it('uses only characters a Sec-WebSocket-Protocol token allows', () => {
    const encoded = encodeBase64Url('a+b/c=d?e f🙂'.repeat(50));

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('decodeBase64Url', () => {
  it('reverses encodeBase64Url', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'çé 🙂 ✓', '﻿abc', 'x'.repeat(11_625)]) {
      expect(decodeBase64Url(encodeBase64Url(text))).toBe(text);
    }
  });

  it('returns null for text that is not base64url', () => {
    expect(decodeBase64Url('a+b')).toBeNull();
    expect(decodeBase64Url('ab==')).toBeNull();
    expect(decodeBase64Url('a')).toBeNull();
  });

  it('returns null for bytes that are not UTF-8', () => {
    expect(decodeBase64Url(Buffer.from([0xff, 0xfe]).toString('base64url'))).toBeNull();
  });
});

describe('tokenSubprotocols', () => {
  it('offers the plain name, then the token name, when the app has no protocols', () => {
    expect(tokenSubprotocols('abc', undefined)).toEqual([
      'livething-v1',
      `livething-v1.token.${encodeBase64Url('abc')}`,
    ]);
  });

  it("puts the app's own protocols first and the token last", () => {
    expect(tokenSubprotocols('abc', ['huddle.v2', 'huddle.v1'])).toEqual([
      'huddle.v2',
      'huddle.v1',
      `livething-v1.token.${encodeBase64Url('abc')}`,
    ]);
  });

  it("offers only the app's protocols when there is no token", () => {
    expect(tokenSubprotocols(undefined, ['huddle.v2'])).toEqual(['huddle.v2']);
    expect(tokenSubprotocols(null, undefined)).toBeUndefined();
    expect(tokenSubprotocols('', undefined)).toBeUndefined();
  });
});

describe('isLiveThingSubprotocol', () => {
  it('names the plain and the token names', () => {
    expect(isLiveThingSubprotocol('livething-v1')).toBe(true);
    expect(isLiveThingSubprotocol('livething-v1.token.abc')).toBe(true);
    expect(isLiveThingSubprotocol('huddle.v2')).toBe(false);
  });
});
