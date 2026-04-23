import { WskitError } from '@wskit/core';
import { describe, expect, it } from 'vitest';
import { CloseCodes, Defer, DeferExhausted, Disconnect, RejectUpgrade } from './errors.ts';

// ===========================================================================
// CloseCodes
// ===========================================================================

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
    const dc = Disconnect(CloseCodes.IDLE, 'Heartbeat timeout');
    expect(dc.code).toBe(4004);
    expect(dc.reason).toBe('Heartbeat timeout');
  });
});

// ===========================================================================
// Disconnect
// ===========================================================================

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

// ===========================================================================
// RejectUpgrade
// ===========================================================================

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

// ===========================================================================
// Defer
// ===========================================================================

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

// ===========================================================================
// DeferExhausted
// ===========================================================================

describe('DeferExhausted', () => {
  it('has code defer-exhausted', () => {
    expect(DeferExhausted.code).toBe('defer-exhausted');
  });

  it('creates WskitError with event, payload, and retries', () => {
    const err = DeferExhausted({
      event: 'send-message',
      payload: { text: 'hello' },
      retries: 3,
    });
    expect(err).toBeInstanceOf(WskitError);
    expect(err.code).toBe('defer-exhausted');
    expect(err.detail.event).toBe('send-message');
    expect(err.detail.payload).toEqual({ text: 'hello' });
    expect(err.detail.retries).toBe(3);
  });

  it('.matches() returns true for valid DeferExhausted error', () => {
    const err = new WskitError('defer-exhausted', {
      event: 'test',
      payload: null,
      retries: 1,
    });
    expect(DeferExhausted.matches(err)).toBe(true);
  });

  it('.matches() returns false for wrong code', () => {
    const err = new WskitError('forbidden', { event: 'x', payload: null, retries: 0 });
    expect(DeferExhausted.matches(err)).toBe(false);
  });

  it('.matches() returns false for non-WskitError', () => {
    expect(DeferExhausted.matches(new Error('defer-exhausted'))).toBe(false);
  });
});
