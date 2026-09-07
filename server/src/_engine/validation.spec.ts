import { isWSKitConfigError } from '@wskit/core';
import {
  assertOneOf,
  assertOptionalPositiveInteger,
  assertPositiveInteger,
} from '~/_engine/validation.ts';
import { describe, expect, it } from 'vitest';

describe('assertPositiveInteger', () => {
  it('accepts a positive integer', () => {
    expect(() => assertPositiveInteger(1, 'x', 'test')).not.toThrow();
    expect(() => assertPositiveInteger(1000, 'x', 'test')).not.toThrow();
  });

  it('rejects zero — a truthy gate would silently skip the cap or hit divide-by-zero', () => {
    let captured: unknown;
    try {
      assertPositiveInteger(0, 'maxChunks', 'recordedStream("feed")');
    } catch (error) {
      captured = error;
    }

    expect(isWSKitConfigError(captured)).toBe(true);
    expect(String(captured)).toMatch(/maxChunks.*must be a positive safe integer/);
  });

  it('rejects negative numbers — setTimeout(negative) collapses to a 0ms retry loop', () => {
    expect(() => assertPositiveInteger(-1, 'delay', 'Defer()')).toThrow(
      /must be a positive safe integer/,
    );
  });

  it('rejects NaN', () => {
    expect(() => assertPositiveInteger(Number.NaN, 'delay', 'Defer()')).toThrow();
  });

  it('rejects Infinity', () => {
    expect(() => assertPositiveInteger(Number.POSITIVE_INFINITY, 'maxAgeMs', 'replay()')).toThrow();
  });

  it('rejects values above MAX_SAFE_INTEGER — integer math silently corrupts', () => {
    expect(() =>
      assertPositiveInteger(Number.MAX_SAFE_INTEGER + 1, 'maxAgeMs', 'replay()'),
    ).toThrow(/must be a positive safe integer/);
  });

  it('rejects non-integer numbers (1.5 would round oddly in retention math)', () => {
    expect(() => assertPositiveInteger(1.5, 'x', 'test')).toThrow();
  });

  it('rejects non-numbers', () => {
    expect(() => assertPositiveInteger('5' as unknown, 'x', 'test')).toThrow();
    expect(() => assertPositiveInteger(undefined, 'x', 'test')).toThrow();
    expect(() => assertPositiveInteger(null, 'x', 'test')).toThrow();
  });
});

describe('assertOptionalPositiveInteger', () => {
  it('accepts undefined — "not set" is a real, separate state from "set to a bad value"', () => {
    expect(() => assertOptionalPositiveInteger(undefined, 'x', 'test')).not.toThrow();
  });

  it('still rejects a set-to-zero value', () => {
    expect(() => assertOptionalPositiveInteger(0, 'maxChunks', 'recordedStream("feed")')).toThrow();
  });

  it('accepts a positive integer', () => {
    expect(() => assertOptionalPositiveInteger(10, 'x', 'test')).not.toThrow();
  });
});

describe('assertOneOf', () => {
  const allowed = ['strict', 'best-effort'] as const;

  const where = { field: 'durability', context: 'replay()' };

  it('accepts an allowed value', () => {
    expect(() => assertOneOf('strict', allowed, where)).not.toThrow();
  });

  it('rejects a typo that would silently pick the else branch', () => {
    let captured: unknown;
    try {
      assertOneOf('oops', allowed, where);
    } catch (error) {
      captured = error;
    }

    expect(isWSKitConfigError(captured)).toBe(true);
    expect(String(captured)).toMatch(/durability.*must be one of 'strict', 'best-effort'/);
  });

  it('rejects non-strings', () => {
    expect(() => assertOneOf(42 as unknown, allowed, where)).toThrow();
    expect(() => assertOneOf(undefined, allowed, where)).toThrow();
  });
});
