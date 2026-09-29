import { WIRE_LIMITS } from '@livething/core';
import { familyKeyError, isReservedEventName, wireIdError } from '~/internal/wire-validation.ts';
import { describe, expect, it } from 'vitest';

describe('wireIdError', () => {
  it('rejects empty, non-string, and over-limit values', () => {
    expect(wireIdError('e', '', 'event')).toMatchObject({ code: 'validation-failed' });
    expect(wireIdError('e', undefined as unknown as string, 'event')).toMatchObject({
      code: 'validation-failed',
    });
    expect(wireIdError('e', 'x'.repeat(WIRE_LIMITS.event + 1), 'event')).toMatchObject({
      code: 'validation-failed',
    });
  });

  it('accepts a value within [1, limit]', () => {
    expect(wireIdError('e', 'a', 'event')).toBeNull();
    expect(wireIdError('e', 'x'.repeat(WIRE_LIMITS.event), 'event')).toBeNull();
  });

  it('rejects reserved protocol names as event names', () => {
    expect(wireIdError('e', '__continueStream__', 'event')).toMatchObject({
      code: 'validation-failed',
    });
    expect(wireIdError('e', '__custom', 'event')).toMatchObject({ code: 'validation-failed' });
  });

  it('accepts ping and pong as event names, because keepalive frames are bare text', () => {
    expect(wireIdError('e', 'ping', 'event')).toBeNull();
    expect(wireIdError('e', 'pong', 'event')).toBeNull();
  });

  it('does not apply the reserved-name rule to channel or streamId fields', () => {
    expect(wireIdError('e', '__custom', 'channel')).toBeNull();
    expect(wireIdError('e', '__custom', 'streamId')).toBeNull();
  });
});

describe('isReservedEventName', () => {
  it('flags the __ namespace, but allows normal names', () => {
    expect(isReservedEventName('ping')).toBe(false);
    expect(isReservedEventName('pong')).toBe(false);
    expect(isReservedEventName('__error__')).toBe(true);
    expect(isReservedEventName('')).toBe(true);
    expect(isReservedEventName('chat')).toBe(false);

    expect(isReservedEventName('ping-pong')).toBe(false);
  });

  it('allows plugin-namespaced events (__<id>::event) but still blocks protocol frames', () => {
    // A plugin event is a real, sendable user event in its namespace.
    expect(isReservedEventName('__acme:presence::heartbeat')).toBe(false);
    expect(isReservedEventName('__e2e:feed::feed')).toBe(false);
    // Even names that are reserved on their own are fine once namespaced.
    expect(isReservedEventName('__acme:hb::ping')).toBe(false);
    expect(isReservedEventName('__acme:hb::pong')).toBe(false);
    // A protocol frame has no `::` and stays reserved.
    expect(isReservedEventName('__streamStart__')).toBe(true);
    expect(isReservedEventName('__subscribe__')).toBe(true);
  });
});

describe('familyKeyError', () => {
  it('allows an absent family but rejects an empty or over-limit one', () => {
    expect(familyKeyError('e', undefined)).toBeNull();
    expect(familyKeyError('e', 'x'.repeat(WIRE_LIMITS.channelFamily))).toBeNull();
    expect(familyKeyError('e', '')).toMatchObject({ code: 'validation-failed' });
    expect(familyKeyError('e', 'x'.repeat(WIRE_LIMITS.channelFamily + 1))).toMatchObject({
      code: 'validation-failed',
    });
  });
});
