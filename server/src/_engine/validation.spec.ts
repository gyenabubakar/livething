import { isWskitConfigError } from '@wskit/core';
import { assertOptionalPositiveInteger, assertPositiveInteger } from '~/_engine/validation.ts';
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
    expect(isWskitConfigError(captured)).toBe(true);
    expect(String(captured)).toMatch(/maxChunks.*must be a positive integer/);
  });

  it('rejects negative numbers — setTimeout(negative) collapses to a 0ms retry loop', () => {
    expect(() => assertPositiveInteger(-1, 'delay', 'Defer()')).toThrow(
      /must be a positive integer/,
    );
  });

  it('rejects NaN', () => {
    expect(() => assertPositiveInteger(Number.NaN, 'delay', 'Defer()')).toThrow();
  });

  it('rejects Infinity', () => {
    expect(() => assertPositiveInteger(Number.POSITIVE_INFINITY, 'maxAgeMs', 'replay()')).toThrow();
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
