import { describe, expect, it } from 'vitest';
import { error } from './errors.ts';
import {
  assertValidWSKitIdentifier,
  exceedsWireLimit,
  isValidWSKitIdentifier,
  WIRE_LIMITS,
} from './identifier.ts';

describe('isValidWSKitIdentifier', () => {
  it('accepts ordinary names, including a single colon for plugin ids', () => {
    expect(isValidWSKitIdentifier('message')).toBe(true);
    expect(isValidWSKitIdentifier('user-joined')).toBe(true);
    expect(isValidWSKitIdentifier('acme:analytics')).toBe(true);
    expect(isValidWSKitIdentifier('_single-underscore-ok')).toBe(true);
  });

  it('rejects empty strings, non-strings, and the reserved __ prefix', () => {
    expect(isValidWSKitIdentifier('')).toBe(false);
    expect(isValidWSKitIdentifier(undefined)).toBe(false);
    expect(isValidWSKitIdentifier(123)).toBe(false);
    expect(isValidWSKitIdentifier('__subscribe__')).toBe(false);
    expect(isValidWSKitIdentifier('__anything')).toBe(false);
  });
});

describe('assertValidWSKitIdentifier', () => {
  it('throws a non-empty-string message for empty/non-string names', () => {
    expect(() => assertValidWSKitIdentifier('', 'event name')).toThrow(
      /event name must be a non-empty string/,
    );
  });

  it('throws a reserved-prefix message for a leading __', () => {
    expect(() => assertValidWSKitIdentifier('__foo', 'event name')).toThrow(/reserved '__' prefix/);
  });

  it('passes through a valid name', () => {
    expect(() => assertValidWSKitIdentifier('ok', 'event name')).not.toThrow();
  });

  it('throws a wire-limit message when the name is over maxLength', () => {
    const tooLong = 'e'.repeat(WIRE_LIMITS.event + 1);
    expect(() => assertValidWSKitIdentifier(tooLong, 'event name', WIRE_LIMITS.event)).toThrow(
      /wire protocol limit is 128/,
    );
  });

  it('allows a name exactly at maxLength', () => {
    const atLimit = 'e'.repeat(WIRE_LIMITS.event);
    expect(() =>
      assertValidWSKitIdentifier(atLimit, 'event name', WIRE_LIMITS.event),
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
});
