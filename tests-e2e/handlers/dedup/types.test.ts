import { describe, expectTypeOf, it } from 'vitest';
import type { DedupClient } from './handler.ts';

describe('DedupClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<DedupClient['incoming']>().not.toBeAny();
    expectTypeOf<DedupClient['outgoing']>().not.toBeAny();
    expectTypeOf<DedupClient['requests']>().not.toBeAny();
    expectTypeOf<DedupClient['streams']>().not.toBeAny();
    expectTypeOf<DedupClient['channels']>().not.toBeAny();
    expectTypeOf<DedupClient['errors']>().not.toBeAny();
  });
});

describe('DedupClient — incoming (server outgoing)', () => {
  it('has echoed', () => {
    expectTypeOf<DedupClient['incoming']['echoed']>().toEqualTypeOf<{ text: string }>();
  });

  it('only echoed in incoming', () => {
    expectTypeOf<keyof DedupClient['incoming']>().toEqualTypeOf<'echoed'>();
  });
});

describe('DedupClient — outgoing (server incoming)', () => {
  it('has do-echo', () => {
    expectTypeOf<DedupClient['outgoing']['do-echo']>().toEqualTypeOf<{ text: string }>();
  });

  it('only do-echo in outgoing', () => {
    expectTypeOf<keyof DedupClient['outgoing']>().toEqualTypeOf<'do-echo'>();
  });
});

describe('DedupClient — channels', () => {
  it('addressing: room is a static channel', () => {
    expectTypeOf<DedupClient['channels']['room']['addressing']>().toEqualTypeOf<'static'>();
  });

  it('has room channel', () => {
    expectTypeOf<DedupClient['channels']>().toHaveProperty('room');
  });

  it('room channel has no incoming or outgoing events', () => {
    expectTypeOf<keyof DedupClient['channels']['room']['incoming']>().toBeNever();
    expectTypeOf<keyof DedupClient['channels']['room']['outgoing']>().toBeNever();
  });
});

describe('DedupClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof DedupClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof DedupClient['streams']>().toBeNever();
  });
});

describe('DedupClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<DedupClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<DedupClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<DedupClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<DedupClient['errors']>().toHaveProperty('internal-error');
  });
});
