import { LiveThingError } from '@livething/core';
import { describe, expect, it } from 'vitest';
import { CloseCodes, CrossInstanceRef, Disconnect, RejectAuth } from './errors.ts';

describe('CloseCodes', () => {
  it('exposes the standard 1xxx codes', () => {
    expect(CloseCodes.NORMAL).toBe(1000);
    expect(CloseCodes.GOING_AWAY).toBe(1001);
  });

  it('exposes the livething 4xxx codes', () => {
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
  it('creates frozen object with __livething, code, reason', () => {
    const dc = Disconnect(4009, 'banned');
    expect(dc.__livething).toBe('disconnect');
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

describe('RejectAuth', () => {
  it('creates frozen object with __livething, code, reason', () => {
    const ru = RejectAuth(4002, 'Invalid token');
    expect(ru.__livething).toBe('reject-auth');
    expect(ru.code).toBe(4002);
    expect(ru.reason).toBe('Invalid token');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(RejectAuth(403, 'test'))).toBe(true);
  });
});

describe('CrossInstanceRef', () => {
  it('carries the rejected operation and instance details', () => {
    const err = CrossInstanceRef({
      operation: 'ctx.channel.request({ to })',
      targetInstance: 'other',
      engineInstance: 'local',
    });

    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('cross-instance-ref');
    expect(err.detail).toEqual({
      operation: 'ctx.channel.request({ to })',
      targetInstance: 'other',
      engineInstance: 'local',
    });
    expect(CrossInstanceRef.matches(err)).toBe(true);
  });
});
