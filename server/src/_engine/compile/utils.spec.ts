/* oxlint-disable @typescript-eslint/no-explicit-any */
import { isWSKitConfigError, WSKitError } from '@wskit/core';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { collectUnique, validateValue } from './utils.ts';

describe('collectUnique', () => {
  const outgoingWhere = { kind: 'outgoing', context: 'plugin("x")' };
  const errorWhere = { kind: 'error', context: 'contract()' };

  it('returns the input untouched when all keys are unique', () => {
    const items = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(collectUnique(items, (i) => i.name, outgoingWhere)).toBe(items);
  });

  it('throws WSKitConfigError naming the duplicated key', () => {
    let captured: unknown;
    try {
      collectUnique([{ name: 'ready' }, { name: 'ready' }], (i) => i.name, outgoingWhere);
    } catch (error) {
      captured = error;
    }
    expect(isWSKitConfigError(captured)).toBe(true);
    expect(String(captured)).toMatch(/duplicate outgoing "ready"/);
  });

  it('throws on the first duplicate even with later ones', () => {
    expect(() =>
      collectUnique(
        [{ code: 'a' }, { code: 'b' }, { code: 'a' }, { code: 'b' }],
        (i) => i.code,
        errorWhere,
      ),
    ).toThrow(/duplicate error "a"/);
  });
});

describe('validateValue — StandardSchema duck-type detection', () => {
  describe('valibot schema', () => {
    const schema = v.object({ name: v.string() });

    it('returns parsed value for valid input', () => {
      expect(validateValue(schema, { name: 'Alice' }, 'test-event')).toEqual({ name: 'Alice' });
    });

    it('throws ValidationFailed WSKitError with issues for invalid input', () => {
      let thrown: unknown;
      try {
        validateValue(schema, { name: 42 }, 'test-event');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WSKitError);
      const wsErr = thrown as WSKitError<'validation-failed', any>;
      expect(wsErr.code).toBe('validation-failed');
      expect(Array.isArray(wsErr.detail.issues)).toBe(true);
      expect(wsErr.detail.issues.length).toBeGreaterThan(0);
      expect(typeof wsErr.detail.issues[0].message).toBe('string');
    });
  });

  describe('zod schema', () => {
    const schema = z.object({ count: z.number() });

    it('returns parsed value for valid input', () => {
      expect(validateValue(schema, { count: 5 }, 'test-event')).toEqual({ count: 5 });
    });

    it('throws ValidationFailed WSKitError with issues for invalid input', () => {
      let thrown: unknown;
      try {
        validateValue(schema, { count: 'not-a-number' }, 'test-event');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WSKitError);
      const wsErr = thrown as WSKitError<'validation-failed', any>;
      expect(wsErr.code).toBe('validation-failed');
      expect(Array.isArray(wsErr.detail.issues)).toBe(true);
      expect(wsErr.detail.issues.length).toBeGreaterThan(0);
      expect(typeof wsErr.detail.issues[0].message).toBe('string');
    });
  });

  describe('no validator', () => {
    it('passes value through unchanged when validator is undefined', () => {
      expect(validateValue(undefined, { raw: true }, 'test-event')).toEqual({ raw: true });
    });

    it('passes value through unchanged when validator is null', () => {
      expect(validateValue(null, 'hello', 'test-event')).toBe('hello');
    });
  });
});
