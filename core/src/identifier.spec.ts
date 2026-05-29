import { describe, expect, it } from 'vitest';
import { error } from './errors.ts';
import { assertValidWSKitIdentifier, isValidWSKitIdentifier } from './identifier.ts';

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
});

describe('error() applies the identifier rule to its code', () => {
  it('accepts a normal kebab code', () => {
    expect(error('not-found').code).toBe('not-found');
  });

  it('rejects a code that starts with the reserved __ prefix', () => {
    expect(() => error('__internal')).toThrow(/reserved '__' prefix/);
  });
});
