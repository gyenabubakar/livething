import { describe, expectTypeOf, it } from 'vitest';
import type { RateLimitClient } from './handler.ts';

describe('RateLimitClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<RateLimitClient['incoming']>().not.toBeAny();
    expectTypeOf<RateLimitClient['outgoing']>().not.toBeAny();
    expectTypeOf<RateLimitClient['clientRequests']>().not.toBeAny();
    expectTypeOf<RateLimitClient['streams']>().not.toBeAny();
    expectTypeOf<RateLimitClient['channels']>().not.toBeAny();

    expectTypeOf<RateLimitClient['errors']>().not.toBeAny();
  });
});

describe('RateLimitClient — top-level incoming (server outgoing)', () => {
  it('has tock', () => {
    expectTypeOf<RateLimitClient['incoming']['tock']>().toEqualTypeOf<{ n: number }>();
  });

  it('has expensive-done with empty payload', () => {
    expectTypeOf<RateLimitClient['incoming']['expensive-done']>().toEqualTypeOf<
      Record<string, never>
    >();
  });

  it('has shared-done with empty payload', () => {
    expectTypeOf<RateLimitClient['incoming']['shared-done']>().toEqualTypeOf<
      Record<string, never>
    >();
  });

  it('exactly three events in top-level incoming', () => {
    expectTypeOf<keyof RateLimitClient['incoming']>().toEqualTypeOf<
      'tock' | 'expensive-done' | 'shared-done'
    >();
  });
});

describe('RateLimitClient — top-level outgoing (server incoming)', () => {
  it('has tick with empty payload', () => {
    expectTypeOf<RateLimitClient['outgoing']['tick']>().toEqualTypeOf<{}>();
  });

  it('has expensive with empty payload', () => {
    expectTypeOf<RateLimitClient['outgoing']['expensive']>().toEqualTypeOf<{}>();
  });

  it('has shared-tick with empty payload', () => {
    expectTypeOf<RateLimitClient['outgoing']['shared-tick']>().toEqualTypeOf<{}>();
  });

  it('exactly three events in top-level outgoing', () => {
    expectTypeOf<keyof RateLimitClient['outgoing']>().toEqualTypeOf<
      'tick' | 'expensive' | 'shared-tick'
    >();
  });
});

describe('RateLimitClient — top-level clientRequests', () => {
  it('has echo-req', () => {
    expectTypeOf<RateLimitClient['clientRequests']>().toHaveProperty('echo-req');
  });

  it('echo-req has correct payload and response', () => {
    expectTypeOf<RateLimitClient['clientRequests']['echo-req']['payload']>().toEqualTypeOf<{
      text: string;
    }>();
    expectTypeOf<RateLimitClient['clientRequests']['echo-req']['response']>().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('RateLimitClient — channels', () => {
  it('addressing: every rate-limit channel is static', () => {
    expectTypeOf<
      RateLimitClient['channels']['inherit-room']['addressing']
    >().toEqualTypeOf<'static'>();
    expectTypeOf<RateLimitClient['channels']['no-limit']['addressing']>().toEqualTypeOf<'static'>();
    expectTypeOf<RateLimitClient['channels']['rooms']['addressing']>().toEqualTypeOf<'static'>();
    expectTypeOf<
      RateLimitClient['channels']['tight-room']['addressing']
    >().toEqualTypeOf<'static'>();
  });

  it('has inherit-room channel', () => {
    expectTypeOf<RateLimitClient['channels']>().toHaveProperty('inherit-room');
  });

  it('inherit-room incoming has msg', () => {
    expectTypeOf<RateLimitClient['channels']['inherit-room']['incoming']['msg']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('inherit-room outgoing has send', () => {
    expectTypeOf<RateLimitClient['channels']['inherit-room']['outgoing']['send']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('has no-limit channel', () => {
    expectTypeOf<RateLimitClient['channels']>().toHaveProperty('no-limit');
  });

  it('no-limit incoming has msg', () => {
    expectTypeOf<RateLimitClient['channels']['no-limit']['incoming']['msg']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('has rooms channel', () => {
    expectTypeOf<RateLimitClient['channels']>().toHaveProperty('rooms');
  });

  it('rooms incoming has chatter-broadcast', () => {
    expectTypeOf<
      RateLimitClient['channels']['rooms']['incoming']['chatter-broadcast']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('rooms outgoing has chatter', () => {
    expectTypeOf<RateLimitClient['channels']['rooms']['outgoing']['chatter']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('has tight-room channel', () => {
    expectTypeOf<RateLimitClient['channels']>().toHaveProperty('tight-room');
  });

  it('tight-room incoming has tight-broadcast', () => {
    expectTypeOf<
      RateLimitClient['channels']['tight-room']['incoming']['tight-broadcast']
    >().toEqualTypeOf<{ text: string }>();
  });

  it('tight-room outgoing has alpha and beta', () => {
    expectTypeOf<RateLimitClient['channels']['tight-room']['outgoing']['alpha']>().toEqualTypeOf<{
      text: string;
    }>();
    expectTypeOf<RateLimitClient['channels']['tight-room']['outgoing']['beta']>().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('RateLimitClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<RateLimitClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<RateLimitClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<RateLimitClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<RateLimitClient['errors']>().toHaveProperty('internal-error');
  });

  it('types connection-busy retry hints in milliseconds', () => {
    expectTypeOf<RateLimitClient['errors']['connection-busy']>().toEqualTypeOf<{
      retryAfterMs: number;
    }>();
  });
});
