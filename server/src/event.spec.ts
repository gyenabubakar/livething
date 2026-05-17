import { event, RESERVED_EVENT_NAMES } from '~/event.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

describe('event() reserved-name guard', () => {
  it('throws when the name is in the reserved set', () => {
    for (const reserved of RESERVED_EVENT_NAMES) {
      expect(() => event(reserved, v.object({}))).toThrow(
        new RegExp(`'${reserved}' is a reserved protocol event name`),
      );
    }
  });

  it('accepts non-reserved names', () => {
    expect(() => event('send-message', v.object({ text: v.string() }))).not.toThrow();
    expect(() => event('typing', v.object({}))).not.toThrow();
    expect(() => event('chat-msg', v.object({}))).not.toThrow();
  });

  it('rejects every double-underscore name — the prefix is reserved for module wire frames', () => {
    // Module authors construct outgoing events with bare names; the
    // framework prefixes them onto the wire as `__module:event`. A
    // user-declared double-underscore event would type-check but then
    // route to the module-only declaration map at runtime and silently
    // fail at send time — block at construction.
    expect(() => event('__weird', v.object({}))).toThrow(/reserved double-underscore prefix/);
    expect(() => event('__acme:flushed', v.object({}))).toThrow(
      /reserved double-underscore prefix/,
    );
  });

  it('rejects every single-underscore name as reserved by shape', () => {
    // Future protocol events must stay non-breaking. Reserving the entire
    // single-underscore prefix means the framework can add new ones later
    // without colliding with user code.
    expect(() => event('_my_custom', v.object({}))).toThrow(/reserved single-underscore prefix/);
    expect(() => event('_anything', v.object({}))).toThrow(/reserved single-underscore prefix/);
    expect(() => event('_abc-123', v.object({}))).toThrow(/reserved single-underscore prefix/);
  });

  it('lists every wire-protocol event the engine consumes or emits', () => {
    // Pin the set so future protocol additions surface as a test failure.
    expect([...RESERVED_EVENT_NAMES].sort()).toEqual(
      [
        'ping',
        'pong',
        '_ack',
        '_error',
        '_replay',
        '_subscribe',
        '_subscribeOk',
        '_unsubscribe',
        '_kicked',
        '_memberJoin',
        '_memberLeave',
        '_memberOnline',
        '_memberOffline',
        '_streamOk',
        '_streamEnd',
        '_streamCancel',
      ].sort(),
    );
  });
});
