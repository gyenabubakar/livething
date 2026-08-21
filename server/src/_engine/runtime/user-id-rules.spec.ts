import { computeBroadcastKey } from '~/_engine/stream-durable/runtime.ts';
import { describe, expect, it } from 'vitest';
import { assertUsableUserId, RESERVED_USER_ID_PREFIX } from './user-key.ts';

describe('user id rules', () => {
  it('accepts an ordinary id, and the empty string for an anonymous connection', () => {
    expect(() => assertUsableUserId('alice')).not.toThrow();
    expect(() => assertUsableUserId('01JBQ7Z3M2K8F4YQ')).not.toThrow();
    expect(() => assertUsableUserId('')).not.toThrow();
  });

  it('rejects an id long enough to collide once truncated', () => {
    expect(() => assertUsableUserId('u'.repeat(257))).toThrow(/256/);
    expect(() => assertUsableUserId('u'.repeat(256))).not.toThrow();
  });

  it('rejects an id in the namespace reserved for internal keys', () => {
    expect(() => assertUsableUserId('__bcast:ch:room__')).toThrow(/reserved/i);
    expect(() => assertUsableUserId('__anything')).toThrow(/reserved/i);
  });

  it('an id that merely contains the prefix is fine — only the start is reserved', () => {
    expect(() => assertUsableUserId('user__bcast')).not.toThrow();
    expect(() => assertUsableUserId('_single')).not.toThrow();
  });

  // The reservation is only worth anything if the keys it protects actually
  // live inside it. Pin every shape a broadcast key can take.
  it('covers every synthetic broadcast key the stream runtime can build', () => {
    const keys = [
      computeBroadcastKey({ channelName: null, channelFamily: null } as never),
      computeBroadcastKey({ channelName: 'room', channelFamily: null } as never),
      computeBroadcastKey({ channelName: 'room', channelFamily: 'rooms' } as never),
    ];
    for (const key of keys) {
      expect(key.startsWith(RESERVED_USER_ID_PREFIX)).toBe(true);
      expect(() => assertUsableUserId(key)).toThrow(/reserved/i);
    }
  });
});
