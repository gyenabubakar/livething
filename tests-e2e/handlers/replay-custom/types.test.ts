import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayCustomClient } from './handler.ts';

describe('ReplayCustomClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ReplayCustomClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['requests']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['streams']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['channels']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['namespaces']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['errors']>().not.toBeAny();
  });
});

describe('ReplayCustomClient — incoming (server outgoing)', () => {
  it('has note', () => {
    expectTypeOf<ReplayCustomClient['incoming']['note']>().toEqualTypeOf<{
      text: string;
      author: string;
    }>();
  });

  it('has confirmed-count', () => {
    expectTypeOf<ReplayCustomClient['incoming']['confirmed-count']>().toEqualTypeOf<{
      total: number;
      confirmed: number;
    }>();
  });

  it('has bad-replay-log', () => {
    expectTypeOf<ReplayCustomClient['incoming']['bad-replay-log']>().toEqualTypeOf<{
      undeclared: string;
    }>();
  });

  it('exactly three events in top-level incoming', () => {
    expectTypeOf<keyof ReplayCustomClient['incoming']>().toEqualTypeOf<
      'note' | 'confirmed-count' | 'bad-replay-log'
    >();
  });
});

describe('ReplayCustomClient — outgoing (server incoming)', () => {
  it('has add-note', () => {
    expectTypeOf<ReplayCustomClient['outgoing']['add-note']>().toEqualTypeOf<{ text: string }>();
  });

  it('has query-bad-replay-log with empty payload', () => {
    expectTypeOf<ReplayCustomClient['outgoing']['query-bad-replay-log']>().toEqualTypeOf<{}>();
  });

  it('has get-confirmed-count with empty payload', () => {
    expectTypeOf<ReplayCustomClient['outgoing']['get-confirmed-count']>().toEqualTypeOf<{}>();
  });
});

describe('ReplayCustomClient — channels', () => {
  it('addressing: custom-room is a static channel', () => {
    expectTypeOf<
      ReplayCustomClient['channels']['custom-room']['addressing']
    >().toEqualTypeOf<'static'>();
  });

  it('has custom-room channel', () => {
    expectTypeOf<ReplayCustomClient['channels']>().toHaveProperty('custom-room');
  });

  it('custom-room incoming has room-note', () => {
    expectTypeOf<
      ReplayCustomClient['channels']['custom-room']['incoming']['room-note']
    >().toEqualTypeOf<{
      text: string;
      author: string;
    }>();
  });

  it('custom-room incoming has room-confirmed-count', () => {
    expectTypeOf<
      ReplayCustomClient['channels']['custom-room']['incoming']['room-confirmed-count']
    >().toEqualTypeOf<{
      total: number;
      confirmed: number;
    }>();
  });

  it('custom-room incoming has room-replay-events', () => {
    expectTypeOf<
      ReplayCustomClient['channels']['custom-room']['incoming']['room-replay-events']
    >().toEqualTypeOf<{
      events: string[];
    }>();
  });

  it('custom-room outgoing has add-room-note (server incoming)', () => {
    expectTypeOf<
      ReplayCustomClient['channels']['custom-room']['outgoing']['add-room-note']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('custom-room outgoing has get-room-confirmed-count with empty payload', () => {
    expectTypeOf<
      ReplayCustomClient['channels']['custom-room']['outgoing']['get-room-confirmed-count']
    >().toEqualTypeOf<{}>();
  });

  it('custom-room outgoing has query-room-replay-events with empty payload', () => {
    expectTypeOf<
      ReplayCustomClient['channels']['custom-room']['outgoing']['query-room-replay-events']
    >().toEqualTypeOf<{}>();
  });

  it('custom-room streams has room-stream', () => {
    expectTypeOf<ReplayCustomClient['channels']['custom-room']['streams']>().toHaveProperty(
      'room-stream',
    );
  });

  it('room-stream has correct payload and chunk', () => {
    expectTypeOf<
      ReplayCustomClient['channels']['custom-room']['streams']['room-stream']['payload']
    >().toEqualTypeOf<{
      count: number;
    }>();
    expectTypeOf<
      ReplayCustomClient['channels']['custom-room']['streams']['room-stream']['chunk']
    >().toEqualTypeOf<{
      token: string;
    }>();
  });
});

describe('ReplayCustomClient — stream kind', () => {
  it('room-stream is ephemeral', () => {
    expectTypeOf<
      ReplayCustomClient['channels']['custom-room']['streams']['room-stream']['kind']
    >().toEqualTypeOf<'ephemeral'>();
  });
});

describe('ReplayCustomClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ReplayCustomClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ReplayCustomClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ReplayCustomClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ReplayCustomClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ReplayCustomClient['errors']>().toHaveProperty('internal-error');
  });
});
