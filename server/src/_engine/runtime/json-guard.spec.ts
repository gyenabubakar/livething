import {
  serializeDurableChunk,
  serializeJsonOrThrow,
  serializePayload,
} from '~/_engine/runtime/json-guard.ts';
import { describe, expect, it } from 'vitest';

describe('serializePayload', () => {
  it('refuses a toJSON() that returns an iterable, which JSON turns into {}', () => {
    async function* pages() {
      yield 1;
    }

    expect(() => serializePayload('news', { toJSON: () => new Map([['a', 1]]) })).toThrow(
      /an iterable such as a Map or a Set/,
    );
    expect(() => serializePayload('news', { toJSON: () => new Set([1]) })).toThrow(
      /an iterable such as a Map or a Set/,
    );
    expect(() => serializePayload('news', { toJSON: () => pages() })).toThrow(
      /an iterable such as a Map or a Set/,
    );
  });

  it('accepts a toJSON() that returns a plain object', () => {
    expect(serializePayload('news', { toJSON: () => ({ text: 'hi' }) })).toBe('{"text":"hi"}');
  });
});

describe('serializeJsonOrThrow', () => {
  it('returns the JSON string for a plain object', () => {
    expect(serializeJsonOrThrow({ a: 1, b: 'two' }, 'test')).toBe('{"a":1,"b":"two"}');
  });

  it('returns the JSON string for null', () => {
    expect(serializeJsonOrThrow(null, 'test')).toBe('null');
  });

  it('throws when the value has toJSON that returns undefined', () => {
    // assertPayloadRecord-style shape checks pass for this object, but the
    // wire/storage layer that splices the result expects a real string —
    // splicing JS undefined produces invalid JSON or drops the column.
    const bad = { toJSON: () => undefined };
    expect(() => serializeJsonOrThrow(bad, 'Test payload for "foo"')).toThrow(
      /Test payload for "foo" did not serialize to JSON/,
    );
  });

  it('throws when the value itself is undefined', () => {
    expect(() => serializeJsonOrThrow(undefined, 'thing')).toThrow(/did not serialize/);
  });

  it('lets JSON.stringify exceptions propagate (e.g. BigInt) — caller decides how to react', () => {
    expect(() => serializeJsonOrThrow({ n: 1n }, 'bigint')).toThrow(TypeError);
  });
});

describe('serializeDurableChunk', () => {
  it('keeps an object, and wraps any other JSON value as { value }', () => {
    expect(serializeDurableChunk('feed', { n: 1 })).toBe('{"n":1}');
    expect(serializeDurableChunk('feed', 1)).toBe('{"value":1}');
    expect(serializeDurableChunk('feed', null)).toBe('{"value":null}');
    expect(serializeDurableChunk('feed', [1, 2])).toBe('{"value":[1,2]}');
    expect(serializeDurableChunk('feed', new Date(0))).toBe('{"value":"1970-01-01T00:00:00.000Z"}');
  });

  it('uses what toJSON() returns, even on a function', () => {
    const callable = Object.assign(() => {}, { toJSON: () => ({ id: 1 }) });

    expect(serializeDurableChunk('feed', callable)).toBe('{"id":1}');
  });

  it('refuses a toJSON() that returns an iterable, which JSON turns into {}', () => {
    expect(() => serializeDurableChunk('feed', { toJSON: () => new Map([['a', 1]]) })).toThrow(
      /an iterable such as a Map or a Set/,
    );
  });

  it('wraps a boxed String as its string, although it is iterable', () => {
    // oxlint-disable-next-line no-new-wrappers -- the boxed value is what is tested
    expect(serializeDurableChunk('feed', new String('hi'))).toBe('{"value":"hi"}');
  });

  it('refuses a chunk with no JSON and an iterable without toJSON()', () => {
    expect(() => serializeDurableChunk('feed', () => {})).toThrow(/function, which has no JSON/);
    expect(() => serializeDurableChunk('feed', undefined)).toThrow(/undefined, which has no JSON/);
    expect(() => serializeDurableChunk('feed', new Map([['a', 1]]))).toThrow(
      /an iterable such as a Map or a Set/,
    );
    async function* pages() {
      yield 1;
    }

    expect(() => serializeDurableChunk('feed', pages())).toThrow(
      /an iterable such as a Map or a Set/,
    );
  });

  it('does not tell the developer that a recorded or cursor chunk must be a plain object', () => {
    let message = '';
    try {
      serializeDurableChunk('feed', undefined);
    } catch (error) {
      message = (error as Error).message;
    }

    // A number, a string, null and an array are valid chunks here: they are wrapped as { value }.
    expect(message).not.toMatch(/must be a plain object|yield an object/);
  });
});
