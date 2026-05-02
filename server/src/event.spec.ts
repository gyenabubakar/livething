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
    // Underscored names that are NOT reserved still work — only the wire-protocol
    // names are blocked.
    expect(() => event('_my_custom', v.object({}))).not.toThrow();
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
        '_streamOk',
        '_streamEnd',
        '_streamCancel',
      ].sort(),
    );
  });
});
