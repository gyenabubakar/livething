import {
  AwarenessRefused,
  Block,
  ChannelNotFound,
  ChannelNotSubscribed,
  CloseCodes,
  ConnectionBusy,
  CrossInstanceRef,
  DurableStreamRequiresUser,
  error,
  InternalError,
  LiveThingError,
  RateLimited,
  RequestNoResponse,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
  UploadAborted,
  ValidationFailed,
  WrongFrameKind,
} from '~/errors.ts';
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
    expect(CloseCodes.PROTOCOL_ERROR).toBe(1002);
    expect(CloseCodes.UNSUPPORTED_DATA).toBe(1003);
    expect(CloseCodes.INTERNAL_ERROR).toBe(1011);

    expect(CloseCodes.TRY_AGAIN_LATER).toBe(1013);

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
// LiveThingError
// ===========================================================================

describe('LiveThingError', () => {
  it('extends Error', () => {
    const err = new LiveThingError('test', null);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LiveThingError);
  });

  it('sets code, detail, name, and message', () => {
    const err = new LiveThingError('forbidden', { reason: 'nope' });
    expect(err.code).toBe('forbidden');
    expect(err.detail).toEqual({ reason: 'nope' });
    expect(err.name).toBe('LiveThingError');
    expect(err.message).toBe('forbidden');

    expect(String(err)).toBe('LiveThingError: forbidden');
  });

  it('has a stack trace', () => {
    const err = new LiveThingError('test', null);
    expect(err.stack).toBeDefined();
  });
});

describe('CrossInstanceRef', () => {
  it('creates and matches the stable cross-instance error', () => {
    const err = CrossInstanceRef({
      operation: 'ctx.channel.request({ to })',
      targetInstance: 'other',
      engineInstance: 'local',
    });

    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('cross-instance-ref');
    expect(CrossInstanceRef.matches(err)).toBe(true);
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

  it('is callable and returns LiveThingError with no detail', () => {
    const err = NotFound();
    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('not-found');
    expect(err.detail).toBeUndefined();
  });

  it('.matches() returns true for matching LiveThingError', () => {
    const err = new LiveThingError('not-found', undefined);
    expect(NotFound.matches(err)).toBe(true);
  });

  it('.matches() returns false for wrong code', () => {
    const err = new LiveThingError('forbidden', undefined);
    expect(NotFound.matches(err)).toBe(false);
  });

  it('.matches() returns false for non-LiveThingError', () => {
    expect(NotFound.matches(new Error('not-found'))).toBe(false);
    expect(NotFound.matches('not-found')).toBe(false);
    expect(NotFound.matches(null)).toBe(false);
    expect(NotFound.matches(undefined)).toBe(false);
    expect(NotFound.matches({ code: 'not-found' })).toBe(false);
  });
});

// ===========================================================================
// error() — with schema
// ===========================================================================

describe('error() with schema', () => {
  const Forbidden = error('forbidden', v.object({ reason: v.string() }));

  it('has the correct code', () => {
    expect(Forbidden.code).toBe('forbidden');
  });

  it('is callable and returns LiveThingError', () => {
    const err = Forbidden({ reason: 'denied' });
    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('forbidden');
    expect(err.detail).toEqual({ reason: 'denied' });
  });

  it('throws when the schema rejects input', () => {
    expect(() => Forbidden({ wrong: true } as unknown as { reason: string })).toThrow(
      'Validation failed',
    );
  });

  it('.matches() returns true for matching error with valid detail', () => {
    const err = new LiveThingError('forbidden', { reason: 'not allowed' });
    expect(Forbidden.matches(err)).toBe(true);
  });

  it('.matches() returns false for matching code but invalid detail', () => {
    const err = new LiveThingError('forbidden', { wrong: true });
    expect(Forbidden.matches(err)).toBe(false);
  });

  it('.matches() returns false for wrong code', () => {
    const err = new LiveThingError('not-found', { reason: 'x' });
    expect(Forbidden.matches(err)).toBe(false);
  });

  it('.matches() returns false for non-LiveThingError', () => {
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

  it('is callable and returns LiveThingError with validated detail', () => {
    const err = QuotaExceeded({ limit: 100 });
    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('quota-exceeded');
    expect(err.detail).toEqual({ limit: 100 });
  });

  it('throws when runtime data fails validation', () => {
    // Simulates bad data arriving over the wire — TS can't catch this
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => QuotaExceeded({ limit: 'not a number' } as any)).toThrow('Validation failed');
  });

  it('.matches() returns true for valid detail', () => {
    const err = new LiveThingError('quota-exceeded', { limit: 50 });
    expect(QuotaExceeded.matches(err)).toBe(true);
  });

  it('.matches() returns false for invalid detail', () => {
    const err = new LiveThingError('quota-exceeded', { limit: 'nope' });
    expect(QuotaExceeded.matches(err)).toBe(false);
  });
});

describe('error() with zod', () => {
  const RateLimited = error('rate-exceeded', z.object({ retryAfterMs: z.number() }));

  it('is callable and returns LiveThingError with validated detail', () => {
    const err = RateLimited({ retryAfterMs: 5000 });
    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('rate-exceeded');
    expect(err.detail).toEqual({ retryAfterMs: 5000 });
  });

  it('throws when runtime data fails validation', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => RateLimited({ retryAfterMs: 'not a number' } as any)).toThrow('Validation failed');
  });

  it('.matches() returns true for valid detail', () => {
    const err = new LiveThingError('rate-exceeded', { retryAfterMs: 3000 });
    expect(RateLimited.matches(err)).toBe(true);
  });
});

// ===========================================================================
// error() — async StandardSchema guard
// ===========================================================================

describe('error() async StandardSchema rejection', () => {
  it('throws when the factory is called with an async valibot schema', () => {
    const asyncSchema = v.pipeAsync(
      v.string(),
      v.checkAsync(async () => true, 'ok'),
    );
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const AsyncDef = error('async-test', asyncSchema as any);
    expect(() => AsyncDef('value' as never)).toThrow(/async validators are not supported/);
  });
});

// ===========================================================================
// .matches() — edge cases
// ===========================================================================

describe('.matches() edge cases', () => {
  const CodeOnly = error('gone');
  const WithDetail = error('rate-exceeded', v.object({ retryAfterMs: v.number() }));

  it('code-only matches regardless of detail value', () => {
    expect(CodeOnly.matches(new LiveThingError('gone', undefined))).toBe(true);
    expect(CodeOnly.matches(new LiveThingError('gone', null))).toBe(true);
    expect(CodeOnly.matches(new LiveThingError('gone', { anything: true }))).toBe(true);
  });

  it('with-detail rejects when validate throws', () => {
    expect(WithDetail.matches(new LiveThingError('rate-exceeded', {}))).toBe(false);
    expect(WithDetail.matches(new LiveThingError('rate-exceeded', null))).toBe(false);
  });

  it('with-detail accepts when validate passes', () => {
    expect(WithDetail.matches(new LiveThingError('rate-exceeded', { retryAfterMs: 5000 }))).toBe(
      true,
    );
  });

  it('multiple error defs do not interfere', () => {
    const err = new LiveThingError('forbidden', { reason: 'x' });
    expect(CodeOnly.matches(err)).toBe(false);
    expect(WithDetail.matches(err)).toBe(false);
  });
});

// ===========================================================================
// error() — factory properties
// ===========================================================================

describe('error factory properties', () => {
  const Forbidden = error('forbidden', v.object({ reason: v.string() }));

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
  it('has __livething tag', () => {
    expect(Block.__livething).toBe('block');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(Block)).toBe(true);
  });

  it('has no other properties', () => {
    expect(Object.keys(Block)).toEqual(['__livething']);
  });
});

// ===========================================================================
// ValidationFailed
// ===========================================================================

describe('ValidationFailed', () => {
  it('has code validation-failed', () => {
    expect(ValidationFailed.code).toBe('validation-failed');
  });

  it('creates LiveThingError with event and issues', () => {
    const err = ValidationFailed({
      event: 'send-message',
      issues: [{ message: 'text is required', path: ['text'] }],
    });
    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('validation-failed');
    expect(err.detail.event).toBe('send-message');
    expect(err.detail.issues).toEqual([{ message: 'text is required', path: ['text'] }]);
  });

  it('.matches() returns true for valid validation error', () => {
    const err = new LiveThingError('validation-failed', {
      event: 'join',
      issues: [{ message: 'bad' }],
    });
    expect(ValidationFailed.matches(err)).toBe(true);
  });

  it('.matches() returns false for wrong code', () => {
    const err = new LiveThingError('forbidden', { event: 'x', issues: [] });
    expect(ValidationFailed.matches(err)).toBe(false);
  });

  it('.matches() returns false for non-LiveThingError', () => {
    expect(ValidationFailed.matches(new Error('validation-failed'))).toBe(false);
  });
});

describe('ValidationFailed parser — bad payload', () => {
  it('throws when detail is not an object', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => ValidationFailed('not-an-object' as any)).toThrow('Validation failed');
  });

  it('throws when detail.event is not a string', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => ValidationFailed({ issues: [] } as any)).toThrow('Validation failed');
  });

  it('throws when detail.issues is not an array', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => ValidationFailed({ event: 'x', issues: 'nope' } as any)).toThrow(
      'Validation failed',
    );
  });

  it('throws when an issue is not an object', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => ValidationFailed({ event: 'x', issues: ['bad'] } as any)).toThrow(
      'Validation failed',
    );
  });

  it('throws when an issue.message is not a string', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => ValidationFailed({ event: 'x', issues: [{ message: 99 }] } as any)).toThrow(
      'Validation failed',
    );
  });

  it('throws when an issue.path is not an array', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() =>
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      ValidationFailed({ event: 'x', issues: [{ message: 'bad', path: 'wrong' }] } as any),
    ).toThrow('Validation failed');
  });

  it('throws when a path element is not a string or number', () => {
    expect(() =>
      ValidationFailed({
        event: 'x',
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any
        issues: [{ message: 'bad', path: [{}] }] as any,
      }),
    ).toThrow('Validation failed');
  });
});

// ===========================================================================
// Code-only built-in errors
// ===========================================================================
//
// One block per built-in. Each asserts the wire code, that the factory builds
// a LiveThingError with that code, and that `.matches()` accepts/rejects the
// right shapes. These guards make silent renames visible in CI.

describe.each([
  { name: 'ChannelNotFound', def: ChannelNotFound, code: 'channel-not-found' as const },
  {
    name: 'ChannelNotSubscribed',
    def: ChannelNotSubscribed,
    code: 'channel-not-subscribed' as const,
  },
  { name: 'InternalError', def: InternalError, code: 'internal-error' as const },
  { name: 'RequestNoResponse', def: RequestNoResponse, code: 'request-no-response' as const },
  { name: 'StreamIdCollision', def: StreamIdCollision, code: 'stream-id-collision' as const },
])('$name (code-only built-in)', ({ def, code }) => {
  it('has the documented code', () => {
    expect(def.code).toBe(code);
  });

  it('factory returns a LiveThingError with the right code and no detail', () => {
    const err = def();
    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe(code);
    expect(err.detail).toBeUndefined();
  });

  it('.matches() accepts the right code, rejects other codes', () => {
    expect(def.matches(new LiveThingError(code, undefined))).toBe(true);
    expect(def.matches(new LiveThingError('something-else', undefined))).toBe(false);
  });

  it('.matches() rejects non-LiveThingError values', () => {
    expect(def.matches(new Error(code))).toBe(false);
    expect(def.matches({ code })).toBe(false);
    expect(def.matches(null)).toBe(false);
    expect(def.matches(undefined)).toBe(false);
  });
});

// ===========================================================================
// StreamAlreadyActive
// ===========================================================================

describe('StreamAlreadyActive', () => {
  it('has code stream-already-active', () => {
    expect(StreamAlreadyActive.code).toBe('stream-already-active');
  });

  it('creates LiveThingError with event and streamId', () => {
    const err = StreamAlreadyActive({ event: 'start-tokens', streamId: 'stream_42' });
    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('stream-already-active');
    expect(err.detail).toEqual({ event: 'start-tokens', streamId: 'stream_42' });
  });

  it('.matches() returns true for a valid detail', () => {
    const err = new LiveThingError('stream-already-active', {
      event: 'start-tokens',
      streamId: 'stream_1',
    });
    expect(StreamAlreadyActive.matches(err)).toBe(true);
  });

  it('.matches() returns false for wrong code', () => {
    const err = new LiveThingError('forbidden', { event: 'x', streamId: 's' });
    expect(StreamAlreadyActive.matches(err)).toBe(false);
  });

  it('.matches() returns false for matching code but invalid detail', () => {
    const err = new LiveThingError('stream-already-active', { event: 'x' });
    expect(StreamAlreadyActive.matches(err)).toBe(false);
  });

  it('.matches() returns false for non-LiveThingError', () => {
    expect(StreamAlreadyActive.matches(new Error('stream-already-active'))).toBe(false);
  });
});

describe('StreamAlreadyActive parser — bad payload', () => {
  it('throws when detail is not an object', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => StreamAlreadyActive('not-an-object' as any)).toThrow('Validation failed');
  });

  it('throws when detail.event is not a string', () => {
    expect(() =>
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      StreamAlreadyActive({ streamId: 'stream_1' } as any),
    ).toThrow('Validation failed');
  });

  it('throws when detail.streamId is not a string', () => {
    expect(() =>
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      StreamAlreadyActive({ event: 'start-tokens' } as any),
    ).toThrow('Validation failed');
  });
});

// ===========================================================================
// UploadAborted
// ===========================================================================

describe('UploadAborted', () => {
  const reasons = [
    'cancelled',
    'too-large',
    'input-mismatch',
    'bad-state',
    'bad-piece',
    'window',
    'taken-over',
    'gone',
    'not-resumable',
    'interrupted',
  ] as const;

  it.each(reasons)('factory accepts reason %s', (reason) => {
    expect(UploadAborted({ reason }).detail).toEqual({ reason });
  });

  it.each(reasons)('.matches() takes reason %s from the wire', (reason) => {
    expect(UploadAborted.matches(new LiveThingError('upload-aborted', { reason }))).toBe(true);
  });
});

// ===========================================================================
// StreamAborted
// ===========================================================================

describe('StreamAborted', () => {
  const reasons = [
    'cancelled',
    'buffer-full',
    'expired',
    'not-found',
    'hibernation-wake',
    'unsubscribed',
    'interrupted',
    'taken-over',
    'aborted',
  ] as const;

  it('has code stream-aborted', () => {
    expect(StreamAborted.code).toBe('stream-aborted');
  });

  it.each(reasons)('factory accepts reason %s', (reason) => {
    const err = StreamAborted({ reason });
    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('stream-aborted');
    expect(err.detail).toEqual({ reason });
  });

  it('.matches() returns true for a valid detail', () => {
    const err = new LiveThingError('stream-aborted', { reason: 'cancelled' });
    expect(StreamAborted.matches(err)).toBe(true);
  });

  it('.matches() returns false for wrong code', () => {
    expect(StreamAborted.matches(new LiveThingError('forbidden', { reason: 'cancelled' }))).toBe(
      false,
    );
  });

  it('.matches() returns false for matching code but invalid detail', () => {
    expect(StreamAborted.matches(new LiveThingError('stream-aborted', { reason: 'nope' }))).toBe(
      false,
    );
    expect(StreamAborted.matches(new LiveThingError('stream-aborted', undefined))).toBe(false);
  });

  it('.matches() returns false for non-LiveThingError', () => {
    expect(StreamAborted.matches(new Error('stream-aborted'))).toBe(false);
  });
});

describe('StreamAborted parser — bad payload', () => {
  it('throws when detail is not an object', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => StreamAborted('not-an-object' as any)).toThrow('Validation failed');
  });

  it('throws when detail.reason is not a known value', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => StreamAborted({ reason: 'unknown' } as any)).toThrow('Validation failed');
  });

  it('throws when detail.reason is missing', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => StreamAborted({} as any)).toThrow('Validation failed');
  });
});

// ===========================================================================
// RateLimited
// ===========================================================================

describe('RateLimited', () => {
  it('has code rate-limited', () => {
    expect(RateLimited.code).toBe('rate-limited');
  });

  it('creates LiveThingError with retryAfterMs', () => {
    const err = RateLimited({ retryAfterMs: 5_000 });
    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('rate-limited');
    expect(err.detail).toEqual({ retryAfterMs: 5_000 });
  });

  it('.matches() returns true for a valid detail', () => {
    const err = new LiveThingError('rate-limited', { retryAfterMs: 2_000 });
    expect(RateLimited.matches(err)).toBe(true);
  });

  it('.matches() returns false for wrong code', () => {
    const err = new LiveThingError('forbidden', { retryAfterMs: 2_000 });
    expect(RateLimited.matches(err)).toBe(false);
  });

  it('.matches() returns false for matching code but invalid detail', () => {
    const err = new LiveThingError('rate-limited', { retryAfterMs: 'soon' });
    expect(RateLimited.matches(err)).toBe(false);
  });

  it('.matches() returns false for non-LiveThingError', () => {
    expect(RateLimited.matches(new Error('rate-limited'))).toBe(false);
  });
});

describe('RateLimited parser — bad payload', () => {
  it('throws when detail is not an object', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => RateLimited('nope' as any)).toThrow('Validation failed');
  });

  it('throws when retryAfterMs is missing or non-numeric', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => RateLimited({} as any)).toThrow('Validation failed');
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => RateLimited({ retryAfterMs: 'soon' } as any)).toThrow('Validation failed');
  });

  it('throws when retryAfterMs is negative or non-finite', () => {
    expect(() => RateLimited({ retryAfterMs: -1 })).toThrow('Validation failed');
    expect(() => RateLimited({ retryAfterMs: Number.POSITIVE_INFINITY })).toThrow(
      'Validation failed',
    );
  });
});

describe('ConnectionBusy', () => {
  it('has a retryAfterMs detail in milliseconds', () => {
    const err = ConnectionBusy({ retryAfterMs: 1_000 });
    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('connection-busy');
    expect(err.detail).toEqual({ retryAfterMs: 1_000 });
    expect(ConnectionBusy.matches(err)).toBe(true);
  });

  it('rejects an invalid detail', () => {
    expect(() => ConnectionBusy({ retryAfterMs: -1 })).toThrow('Validation failed');
    expect(() => ConnectionBusy({ retryAfterMs: 'soon' } as never)).toThrow('Validation failed');
  });
});

// ===========================================================================
// Throw → catch → narrow roundtrip
// ===========================================================================
//
// The factory + .matches() pair is the actual path apps use: throw the
// factory, catch with the unknown-typed error, narrow with .matches().
// Tests above only exercised constructor-built instances.

describe('factory throw + catch + .matches() roundtrip', () => {
  it('code-only built-in', () => {
    try {
      throw ChannelNotFound();
    } catch (err) {
      expect(ChannelNotFound.matches(err)).toBe(true);
      expect(StreamAborted.matches(err)).toBe(false);
    }
  });

  it('built-in with detail', () => {
    try {
      throw StreamAlreadyActive({ event: 'start-tokens', streamId: 'stream_1' });
    } catch (err) {
      expect(StreamAlreadyActive.matches(err)).toBe(true);
      if (StreamAlreadyActive.matches(err)) {
        expect(err.detail.event).toBe('start-tokens');
        expect(err.detail.streamId).toBe('stream_1');
      }
    }
  });
});

// ===========================================================================
// Built-in code registry
// ===========================================================================
//
// One snapshot of every built-in error code LiveThing ships. A rename, a new
// addition, or a deletion fails this test and forces the change to surface
// in the diff. The map is the canonical list of wire codes the framework
// claims; consumers (client SDK, dashboards, audit logs) can read it here.

describe('built-in error codes', () => {
  it('matches the documented set', () => {
    expect({
      ValidationFailed: ValidationFailed.code,
      ChannelNotFound: ChannelNotFound.code,
      ChannelNotSubscribed: ChannelNotSubscribed.code,
      InternalError: InternalError.code,
      RequestNoResponse: RequestNoResponse.code,
      StreamAborted: StreamAborted.code,
      StreamAlreadyActive: StreamAlreadyActive.code,
      StreamIdCollision: StreamIdCollision.code,
      ConnectionBusy: ConnectionBusy.code,
    }).toEqual({
      ValidationFailed: 'validation-failed',
      ChannelNotFound: 'channel-not-found',
      ChannelNotSubscribed: 'channel-not-subscribed',
      InternalError: 'internal-error',
      RequestNoResponse: 'request-no-response',
      StreamAborted: 'stream-aborted',
      StreamAlreadyActive: 'stream-already-active',
      StreamIdCollision: 'stream-id-collision',
      ConnectionBusy: 'connection-busy',
    });
  });
});

describe('error() reserved-code guard', () => {
  it('throws when a developer redeclares a built-in framework code', () => {
    expect(() => error('rate-limited')).toThrow(/reserved/);
    expect(() => error('validation-failed')).toThrow(/reserved/);
    expect(() => error('channel-not-found')).toThrow(/reserved/);
    expect(() => error('cross-instance-ref')).toThrow(/reserved/);
    expect(() => error('stream-aborted')).toThrow(/reserved/);

    expect(() => error('connection-busy')).toThrow(/reserved/);
    expect(() => error(DurableStreamRequiresUser.code)).toThrow(/reserved/);
  });

  it('reserves the client-side and server-only built-in codes too', () => {
    expect(() => error('timeout')).toThrow(/reserved/);
    expect(() => error('disconnected')).toThrow(/reserved/);
    expect(() => error('dropped')).toThrow(/reserved/);
    expect(() => error('not-a-member')).toThrow(/reserved/);
  });

  it('reserves awareness-refused and checks its reason', () => {
    expect(() => error('awareness-refused')).toThrow(/reserved/);
    const refused = AwarenessRefused({ event: '__awarenessSet__', reason: 'too-large' });
    expect(AwarenessRefused.matches(refused)).toBe(true);
    expect(refused.detail).toEqual({ event: '__awarenessSet__', reason: 'too-large' });
    expect(() =>
      AwarenessRefused({ event: '__awarenessSet__', reason: 'slow' as 'error' }),
    ).toThrow();
  });

  it('reserves wrong-frame-kind, the error for a frame of the wrong kind (text or binary)', () => {
    expect(() => error('wrong-frame-kind')).toThrow(/reserved/);
    const wrong = WrongFrameKind({ event: 'upload-avatar', expected: 'binary' });
    expect(wrong.code).toBe('wrong-frame-kind');
    expect(WrongFrameKind.matches(wrong)).toBe(true);
    expect(wrong.detail).toEqual({ event: 'upload-avatar', expected: 'binary' });
  });

  it('allows a non-reserved code', () => {
    expect(() => error('my-app-error')).not.toThrow();
    expect(() => error('quota-exceeded', v.object({ limit: v.number() }))).not.toThrow();
  });
});
