import {
  parseJsonOrUndefined,
  serializeDurableChunk,
  serializeJsonOrThrow,
} from '~/_engine/runtime/json-guard.ts';
import { describe, expect, it } from 'vitest';

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

describe('parseJsonOrUndefined', () => {
  it('returns parsed JSON values', () => {
    expect(parseJsonOrUndefined('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns undefined for null and malformed JSON', () => {
    expect(parseJsonOrUndefined(null)).toBeUndefined();
    expect(parseJsonOrUndefined('not-json')).toBeUndefined();
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

  it('refuses a chunk with no JSON and an iterable without toJSON()', () => {
    expect(() => serializeDurableChunk('feed', () => {})).toThrow(/function, which has no JSON/);
    expect(() => serializeDurableChunk('feed', undefined)).toThrow(/undefined, which has no JSON/);
    expect(() => serializeDurableChunk('feed', new Map([['a', 1]]))).toThrow(
      /an iterable such as a Map or a Set/,
    );
  });
});
