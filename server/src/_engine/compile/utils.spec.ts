/* oxlint-disable @typescript-eslint/no-explicit-any */
import { WskitError } from '@wskit/core';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { stripProtocolFields, validateValue } from './utils.ts';

describe('validateValue — StandardSchema duck-type detection', () => {
  describe('valibot schema', () => {
    const schema = v.object({ name: v.string() });

    it('returns parsed value for valid input', () => {
      expect(validateValue(schema, { name: 'Alice' }, 'test-event')).toEqual({ name: 'Alice' });
    });

    it('throws ValidationFailed WskitError with issues for invalid input', () => {
      let thrown: unknown;
      try {
        validateValue(schema, { name: 42 }, 'test-event');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WskitError);
      const wsErr = thrown as WskitError<'validation-failed', any>;
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

    it('throws ValidationFailed WskitError with issues for invalid input', () => {
      let thrown: unknown;
      try {
        validateValue(schema, { count: 'not-a-number' }, 'test-event');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WskitError);
      const wsErr = thrown as WskitError<'validation-failed', any>;
      expect(wsErr.code).toBe('validation-failed');
      expect(Array.isArray(wsErr.detail.issues)).toBe(true);
      expect(wsErr.detail.issues.length).toBeGreaterThan(0);
      expect(typeof wsErr.detail.issues[0].message).toBe('string');
    });
  });

  describe('plain validator function', () => {
    it('calls the function and returns its result', () => {
      function validator(val: unknown) {
        return { coerced: String(val) };
      }
      expect(validateValue(validator, 42, 'test-event')).toEqual({ coerced: '42' });
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

describe('stripProtocolFields', () => {
  it('removes the eight reserved transport keys', () => {
    expect(
      stripProtocolFields({
        text: 'hi',
        _channel: 'rooms',
        _channelScope: 'rooms',
        _namespace: 'admin',
        _correlationId: 'corr',
        _ackId: 'ack',
        _messageId: 'mid',
        _seq: 5,
        _streamId: 'stream',
      }),
    ).toEqual({ text: 'hi' });
  });

  it('leaves regular keys (and underscore-suffixed keys with no leading underscore semantics) untouched', () => {
    expect(stripProtocolFields({ a: 1, b: 'x', nested: { _channel: 'no-strip' } })).toEqual({
      a: 1,
      b: 'x',
      nested: { _channel: 'no-strip' },
    });
  });

  it('returns primitives, arrays, null, and undefined unchanged', () => {
    expect(stripProtocolFields(undefined)).toBeUndefined();
    expect(stripProtocolFields(null)).toBeNull();
    expect(stripProtocolFields(42)).toBe(42);
    expect(stripProtocolFields('text')).toBe('text');
    const arr = [1, 2, 3];
    expect(stripProtocolFields(arr)).toBe(arr);
  });

  it('returns a clone, not the original object', () => {
    const original = { text: 'hi', _channel: 'foo' };
    const cleaned = stripProtocolFields(original) as Record<string, unknown>;
    expect(cleaned).not.toBe(original);
    expect(original._channel).toBe('foo');
  });
});
