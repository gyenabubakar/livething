import { WSKitError } from '@wskit/core';
import { describe, expect, it } from 'vitest';
import {
  CloseCodes,
  CrossInstanceRef,
  Defer,
  DeferExhausted,
  Disconnect,
  RejectUpgrade,
} from './errors.ts';

describe('CloseCodes', () => {
  it('exposes the standard 1xxx codes', () => {
    expect(CloseCodes.NORMAL).toBe(1000);
    expect(CloseCodes.GOING_AWAY).toBe(1001);
  });

  it('exposes the wskit 4xxx codes', () => {
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

  it('Disconnect(CloseCodes.IDLE, ...) produces code 4004', () => {
    const dc = Disconnect(CloseCodes.IDLE, 'Keepalive timeout');
    expect(dc.code).toBe(4004);
    expect(dc.reason).toBe('Keepalive timeout');
  });
});

describe('Disconnect', () => {
  it('creates frozen object with __wskit, code, reason', () => {
    const dc = Disconnect(4009, 'banned');
    expect(dc.__wskit).toBe('disconnect');
    expect(dc.code).toBe(4009);
    expect(dc.reason).toBe('banned');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(Disconnect(1000, 'test'))).toBe(true);
  });

  it('creates distinct instances', () => {
    const a = Disconnect(4001, 'a');
    const b = Disconnect(4002, 'b');
    expect(a).not.toBe(b);
    expect(a.code).toBe(4001);
    expect(b.code).toBe(4002);
  });
});

describe('RejectUpgrade', () => {
  it('creates frozen object with __wskit, code, reason', () => {
    const ru = RejectUpgrade(4002, 'Invalid token');
    expect(ru.__wskit).toBe('reject-upgrade');
    expect(ru.code).toBe(4002);
    expect(ru.reason).toBe('Invalid token');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(RejectUpgrade(403, 'test'))).toBe(true);
  });
});

describe('Defer', () => {
  it('creates frozen object with __wskit and delay', () => {
    const df = Defer(1000);
    expect(df.__wskit).toBe('defer');
    expect(df.delay).toBe(1000);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(Defer(500))).toBe(true);
  });
});

describe('DeferExhausted', () => {
  it('has code defer-exhausted', () => {
    expect(DeferExhausted.code).toBe('defer-exhausted');
  });

  it('creates WSKitError with event, payload, and retries', () => {
    const err = DeferExhausted({
      event: 'send-message',
      payload: { text: 'hello' },
      retries: 3,
    });
    expect(err).toBeInstanceOf(WSKitError);
    expect(err.code).toBe('defer-exhausted');
    expect(err.detail.event).toBe('send-message');
    expect(err.detail.payload).toEqual({ text: 'hello' });

    expect(err.detail.retries).toBe(3);
  });

  it('.matches() returns true for valid DeferExhausted error', () => {
    const err = new WSKitError('defer-exhausted', {
      event: 'test',
      payload: null,
      retries: 1,
    });
    expect(DeferExhausted.matches(err)).toBe(true);
  });

  it('.matches() returns false for wrong code', () => {
    const err = new WSKitError('forbidden', { event: 'x', payload: null, retries: 0 });
    expect(DeferExhausted.matches(err)).toBe(false);
  });

  it('.matches() returns false for non-WSKitError', () => {
    expect(DeferExhausted.matches(new Error('defer-exhausted'))).toBe(false);
  });
});

describe('DeferExhausted parser — bad payload', () => {
  it('throws when detail is not an object', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => DeferExhausted('not-an-object' as any)).toThrow('Validation failed');
  });

  it('throws when detail.event is not a string', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => DeferExhausted({ retries: 3 } as any)).toThrow('Validation failed');
  });

  it('throws when detail.retries is not a number', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => DeferExhausted({ event: 'x', retries: 'nope' } as any)).toThrow(
      'Validation failed',
    );
  });

  it('throws when detail.retries is Infinity', () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => DeferExhausted({ event: 'x', retries: Infinity } as any)).toThrow(
      'Validation failed',
    );
  });
});

describe('CrossInstanceRef', () => {
  it('carries the rejected operation and instance details', () => {
    const err = CrossInstanceRef({
      operation: 'ctx.channel.request({ to })',
      targetInstance: 'other',
      engineInstance: 'local',
    });

    expect(err).toBeInstanceOf(WSKitError);
    expect(err.code).toBe('cross-instance-ref');
    expect(err.detail).toEqual({
      operation: 'ctx.channel.request({ to })',
      targetInstance: 'other',
      engineInstance: 'local',
    });
    expect(CrossInstanceRef.matches(err)).toBe(true);
  });
});
