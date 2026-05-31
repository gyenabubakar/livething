import { serializeJsonOrThrow } from '~/_engine/runtime/json-guard.ts';
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

  it('throws when a nested toJSON returns undefined at the top level (the wrapper IS the bad value)', () => {
    class Wrapped {
      toJSON() {
        return undefined;
      }
    }
    expect(() => serializeJsonOrThrow(new Wrapped(), 'wrapped')).toThrow(/did not serialize/);
  });

  it('lets JSON.stringify exceptions propagate (e.g. BigInt) — caller decides how to react', () => {
    expect(() => serializeJsonOrThrow({ n: 1n }, 'bigint')).toThrow(TypeError);
  });
});
