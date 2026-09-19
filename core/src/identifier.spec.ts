import { describe, expect, it } from 'vitest';
import { error } from './errors.ts';
import {
  assertValidLiveThingIdentifier,
  exceedsWireLimit,
  isValidLiveThingIdentifier,
  WIRE_LIMITS,
} from './identifier.ts';

describe('isValidLiveThingIdentifier', () => {
  it('accepts ordinary names, including a single colon for plugin ids', () => {
    expect(isValidLiveThingIdentifier('message')).toBe(true);
    expect(isValidLiveThingIdentifier('user-joined')).toBe(true);
    expect(isValidLiveThingIdentifier('acme:analytics')).toBe(true);
    expect(isValidLiveThingIdentifier('_single-underscore-ok')).toBe(true);
  });

  it('rejects empty strings, non-strings, and reserved double-underscore edges', () => {
    expect(isValidLiveThingIdentifier('')).toBe(false);
    expect(isValidLiveThingIdentifier(undefined)).toBe(false);
    expect(isValidLiveThingIdentifier(123)).toBe(false);
    expect(isValidLiveThingIdentifier('__subscribe__')).toBe(false);
    expect(isValidLiveThingIdentifier('__anything')).toBe(false);

    expect(isValidLiveThingIdentifier('anything__')).toBe(false);
  });
});

describe('assertValidLiveThingIdentifier', () => {
  it('throws a non-empty-string message for empty/non-string names', () => {
    expect(() => assertValidLiveThingIdentifier('', 'event name')).toThrow(
      /event name must be a non-empty string/,
    );
  });

  it('throws a reserved-prefix message for a leading __', () => {
    expect(() => assertValidLiveThingIdentifier('__foo', 'event name')).toThrow(
      /reserved '__' prefix/,
    );
  });

  it('throws a reserved-suffix message for a trailing __', () => {
    expect(() => assertValidLiveThingIdentifier('foo__', 'event name')).toThrow(
      /reserved '__' suffix/,
    );
  });

  it('passes through a valid name', () => {
    expect(() => assertValidLiveThingIdentifier('ok', 'event name')).not.toThrow();
  });

  it('throws a wire-limit message when the name is over maxLength', () => {
    const tooLong = 'e'.repeat(WIRE_LIMITS.event + 1);
    expect(() => assertValidLiveThingIdentifier(tooLong, 'event name', WIRE_LIMITS.event)).toThrow(
      /wire protocol limit is 128/,
    );
  });

  it('allows a name exactly at maxLength', () => {
    const atLimit = 'e'.repeat(WIRE_LIMITS.event);
    expect(() =>
      assertValidLiveThingIdentifier(atLimit, 'event name', WIRE_LIMITS.event),
    ).not.toThrow();
  });
});

describe('WIRE_LIMITS / exceedsWireLimit', () => {
  it('pins the protocol limits so client and server cannot drift', () => {
    expect(WIRE_LIMITS).toEqual({
      event: 128,
      channel: 256,
      channelFamily: 128,
      streamId: 128,
      wireId: 128,
    });
  });

  it('is true only for strings longer than the limit', () => {
    expect(exceedsWireLimit('x'.repeat(129), 128)).toBe(true);
    expect(exceedsWireLimit('x'.repeat(128), 128)).toBe(false);
    expect(exceedsWireLimit('', 128)).toBe(false);
    expect(exceedsWireLimit(undefined, 128)).toBe(false);
    expect(exceedsWireLimit(42, 128)).toBe(false);
  });
});

describe('error() applies the identifier rule to its code', () => {
  it('accepts a normal kebab code', () => {
    expect(error('not-found').code).toBe('not-found');
  });

  it('rejects a code that starts with the reserved __ prefix', () => {
    expect(() => error('__internal')).toThrow(/reserved '__' prefix/);
  });

  it('rejects a code that ends with the reserved __ suffix', () => {
    expect(() => error('internal__')).toThrow(/reserved '__' suffix/);
  });
});
