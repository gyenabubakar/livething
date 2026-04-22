import { Block, CloseCodes, error, ValidationFailed, WskitError } from '~/errors.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// ===========================================================================
// CloseCodes
// ===========================================================================

describe('CloseCodes', () => {
  it('has all expected codes', () => {
    expect(CloseCodes.NORMAL).toBe(1000);
    expect(CloseCodes.GOING_AWAY).toBe(1001);
    expect(CloseCodes.AUTH_EXPIRED).toBe(4001);
    expect(CloseCodes.AUTH_INVALID).toBe(4002);
    expect(CloseCodes.DUPLICATE).toBe(4003);
    expect(CloseCodes.IDLE).toBe(4004);
    expect(CloseCodes.RATE_LIMITED).toBe(4005);
    expect(CloseCodes.BANNED).toBe(4009);
    expect(CloseCodes.CAPACITY).toBe(4010);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CloseCodes)).toBe(true);
  });
});

// ===========================================================================
// WskitError
// ===========================================================================

describe('WskitError', () => {
  it('extends Error', () => {
    const err = new WskitError('test', null);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WskitError);
  });

  it('sets code, detail, name, and message', () => {
    const err = new WskitError('forbidden', { reason: 'nope' });
    expect(err.code).toBe('forbidden');
    expect(err.detail).toEqual({ reason: 'nope' });
    expect(err.name).toBe('WskitError');
    expect(err.message).toBe('WskitError: forbidden');
  });

  it('has a stack trace', () => {
    const err = new WskitError('test', null);
    expect(err.stack).toBeDefined();
  });
});

// ===========================================================================
// error() — code-only
// ===========================================================================

describe('error() code-only', () => {
  const NotFound = error('not-found');

  it('has the correct code', () => {
    expect(NotFound.code).toBe('not-found');
  });

  it('is not callable', () => {
    expect(typeof NotFound).toBe('object');
  });

  it('.matches() returns true for matching WskitError', () => {
    const err = new WskitError('not-found', undefined);
    expect(NotFound.matches(err)).toBe(true);
  });

  it('.matches() returns false for wrong code', () => {
    const err = new WskitError('forbidden', undefined);
    expect(NotFound.matches(err)).toBe(false);
  });

  it('.matches() returns false for non-WskitError', () => {
    expect(NotFound.matches(new Error('not-found'))).toBe(false);
    expect(NotFound.matches('not-found')).toBe(false);
    expect(NotFound.matches(null)).toBe(false);
    expect(NotFound.matches(undefined)).toBe(false);
    expect(NotFound.matches({ code: 'not-found' })).toBe(false);
  });
});

// ===========================================================================
// error() — parse function
// ===========================================================================

describe('error() with parse function', () => {
  const Forbidden = error('forbidden', (p: unknown) => {
    const obj = p as Record<string, unknown>;
    if (typeof obj.reason !== 'string') throw new Error('reason required');
    return { reason: obj.reason };
  });

  it('has the correct code', () => {
    expect(Forbidden.code).toBe('forbidden');
  });

  it('is callable and returns WskitError', () => {
    const err = Forbidden({ reason: 'denied' });
    expect(err).toBeInstanceOf(WskitError);
    expect(err.code).toBe('forbidden');
    expect(err.detail).toEqual({ reason: 'denied' });
  });

  it('throws when parse function rejects input', () => {
    expect(() => Forbidden({ wrong: true } as unknown as { reason: string })).toThrow(
      'reason required',
    );
  });

  it('.matches() returns true for matching error with valid detail', () => {
    const err = new WskitError('forbidden', { reason: 'not allowed' });
    expect(Forbidden.matches(err)).toBe(true);
  });

  it('.matches() returns false for matching code but invalid detail', () => {
    const err = new WskitError('forbidden', { wrong: true });
    expect(Forbidden.matches(err)).toBe(false);
  });

  it('.matches() returns false for wrong code', () => {
    const err = new WskitError('not-found', { reason: 'x' });
    expect(Forbidden.matches(err)).toBe(false);
  });

  it('.matches() returns false for non-WskitError', () => {
    expect(Forbidden.matches(new Error('forbidden'))).toBe(false);
  });
});

// ===========================================================================
// error() — StandardSchema
// ===========================================================================

describe('error() with valibot', () => {
  const QuotaExceeded = error('quota-exceeded', v.object({ limit: v.number() }));

  it('has the correct code', () => {
    expect(QuotaExceeded.code).toBe('quota-exceeded');
  });

  it('is callable and returns WskitError with validated detail', () => {
    const err = QuotaExceeded({ limit: 100 });
    expect(err).toBeInstanceOf(WskitError);
    expect(err.code).toBe('quota-exceeded');
    expect(err.detail).toEqual({ limit: 100 });
  });

  it('throws when runtime data fails validation', () => {
    // Simulates bad data arriving over the wire — TS can't catch this
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => QuotaExceeded({ limit: 'not a number' } as any)).toThrow('Validation failed');
  });

  it('.matches() returns true for valid detail', () => {
    const err = new WskitError('quota-exceeded', { limit: 50 });
    expect(QuotaExceeded.matches(err)).toBe(true);
  });

  it('.matches() returns false for invalid detail', () => {
    const err = new WskitError('quota-exceeded', { limit: 'nope' });
    expect(QuotaExceeded.matches(err)).toBe(false);
  });
});

describe('error() with zod', () => {
  const RateLimited = error('rate-limited', z.object({ retryAfter: z.number() }));

  it('is callable and returns WskitError with validated detail', () => {
    const err = RateLimited({ retryAfter: 5000 });
    expect(err).toBeInstanceOf(WskitError);
    expect(err.code).toBe('rate-limited');
    expect(err.detail).toEqual({ retryAfter: 5000 });
  });

  it('throws when runtime data fails validation', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => RateLimited({ retryAfter: 'not a number' } as any)).toThrow('Validation failed');
  });

  it('.matches() returns true for valid detail', () => {
    const err = new WskitError('rate-limited', { retryAfter: 3000 });
    expect(RateLimited.matches(err)).toBe(true);
  });
});

// ===========================================================================
// .matches() — edge cases
// ===========================================================================

describe('.matches() edge cases', () => {
  const CodeOnly = error('gone');
  const WithDetail = error('rate-limited', (p: unknown) => {
    const obj = p as Record<string, unknown>;
    if (typeof obj.retryAfter !== 'number') throw new Error('retryAfter required');
    return { retryAfter: obj.retryAfter };
  });

  it('code-only matches regardless of detail value', () => {
    expect(CodeOnly.matches(new WskitError('gone', undefined))).toBe(true);
    expect(CodeOnly.matches(new WskitError('gone', null))).toBe(true);
    expect(CodeOnly.matches(new WskitError('gone', { anything: true }))).toBe(true);
  });

  it('with-detail rejects when validate throws', () => {
    expect(WithDetail.matches(new WskitError('rate-limited', {}))).toBe(false);
    expect(WithDetail.matches(new WskitError('rate-limited', null))).toBe(false);
  });

  it('with-detail accepts when validate passes', () => {
    expect(WithDetail.matches(new WskitError('rate-limited', { retryAfter: 5000 }))).toBe(true);
  });

  it('multiple error defs do not interfere', () => {
    const err = new WskitError('forbidden', { reason: 'x' });
    expect(CodeOnly.matches(err)).toBe(false);
    expect(WithDetail.matches(err)).toBe(false);
  });
});

// ===========================================================================
// error() — factory properties
// ===========================================================================

describe('error factory properties', () => {
  const Forbidden = error('forbidden', (p: unknown) => p as { reason: string });

  it('.code is accessible on the factory', () => {
    expect(Forbidden.code).toBe('forbidden');
  });

  it('.matches is a function on the factory', () => {
    expect(typeof Forbidden.matches).toBe('function');
  });

  it('factory creates distinct instances', () => {
    const a = Forbidden({ reason: 'a' });
    const b = Forbidden({ reason: 'b' });
    expect(a).not.toBe(b);
    expect(a.detail.reason).toBe('a');
    expect(b.detail.reason).toBe('b');
  });
});

// ===========================================================================
// Block
// ===========================================================================

describe('Block', () => {
  it('has __wskit tag', () => {
    expect(Block.__wskit).toBe('block');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(Block)).toBe(true);
  });

  it('has no other properties', () => {
    expect(Object.keys(Block)).toEqual(['__wskit']);
  });
});

// ===========================================================================
// ValidationFailed
// ===========================================================================

describe('ValidationFailed', () => {
  it('has code validation-failed', () => {
    expect(ValidationFailed.code).toBe('validation-failed');
  });

  it('creates WskitError with event and issues', () => {
    const err = ValidationFailed({
      event: 'send-message',
      issues: [{ message: 'text is required', path: ['text'] }],
    });
    expect(err).toBeInstanceOf(WskitError);
    expect(err.code).toBe('validation-failed');
    expect(err.detail.event).toBe('send-message');
    expect(err.detail.issues).toEqual([{ message: 'text is required', path: ['text'] }]);
  });

  it('.matches() returns true for valid validation error', () => {
    const err = new WskitError('validation-failed', {
      event: 'join',
      issues: [{ message: 'bad' }],
    });
    expect(ValidationFailed.matches(err)).toBe(true);
  });

  it('.matches() returns false for wrong code', () => {
    const err = new WskitError('forbidden', { event: 'x', issues: [] });
    expect(ValidationFailed.matches(err)).toBe(false);
  });

  it('.matches() returns false for non-WskitError', () => {
    expect(ValidationFailed.matches(new Error('validation-failed'))).toBe(false);
  });
});
