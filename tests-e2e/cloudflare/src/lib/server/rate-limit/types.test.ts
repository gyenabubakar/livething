import { describe, expectTypeOf, it } from 'vitest';
import type { RateLimitClient } from './handler.ts';

describe('RateLimitClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<RateLimitClient['incoming']>().not.toBeAny();
    expectTypeOf<RateLimitClient['outgoing']>().not.toBeAny();
    expectTypeOf<RateLimitClient['requests']>().not.toBeAny();
    expectTypeOf<RateLimitClient['streams']>().not.toBeAny();
    expectTypeOf<RateLimitClient['channels']>().not.toBeAny();
    expectTypeOf<RateLimitClient['namespaces']>().not.toBeAny();
    expectTypeOf<RateLimitClient['errors']>().not.toBeAny();
  });
});

describe('RateLimitClient — top-level incoming (server outgoing)', () => {
  it('has tock', () => {
    expectTypeOf<RateLimitClient['incoming']['tock']>().toEqualTypeOf<{ n: number }>();
  });

  it('has expensive-done with empty payload', () => {
    expectTypeOf<RateLimitClient['incoming']['expensive-done']>().toEqualTypeOf<{}>();
  });

  it('exactly two events in top-level incoming', () => {
    expectTypeOf<keyof RateLimitClient['incoming']>().toEqualTypeOf<'tock' | 'expensive-done'>();
  });
});

describe('RateLimitClient — top-level outgoing (server incoming)', () => {
  it('has tick with empty payload', () => {
    expectTypeOf<RateLimitClient['outgoing']['tick']>().toEqualTypeOf<{}>();
  });

  it('has expensive with empty payload', () => {
    expectTypeOf<RateLimitClient['outgoing']['expensive']>().toEqualTypeOf<{}>();
  });

  it('exactly two events in top-level outgoing', () => {
    expectTypeOf<keyof RateLimitClient['outgoing']>().toEqualTypeOf<'tick' | 'expensive'>();
  });
});

describe('RateLimitClient — top-level requests', () => {
  it('has echo-req', () => {
    expectTypeOf<RateLimitClient['requests']>().toHaveProperty('echo-req');
  });

  it('echo-req has correct payload and response', () => {
    expectTypeOf<RateLimitClient['requests']['echo-req']['payload']>().toEqualTypeOf<{
      text: string;
    }>();
    expectTypeOf<RateLimitClient['requests']['echo-req']['response']>().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('RateLimitClient — channels', () => {
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
    >().toEqualTypeOf<{ text: string }>();
  });

  it('rooms outgoing has chatter', () => {
    expectTypeOf<RateLimitClient['channels']['rooms']['outgoing']['chatter']>().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('RateLimitClient — namespaces', () => {
  it('has strict namespace', () => {
    expectTypeOf<RateLimitClient['namespaces']>().toHaveProperty('strict');
  });

  it('strict incoming has strict-pong (server outgoing)', () => {
    expectTypeOf<
      RateLimitClient['namespaces']['strict']['incoming']['strict-pong']
    >().toEqualTypeOf<{}>();
  });

  it('strict outgoing has strict-ping (server incoming)', () => {
    expectTypeOf<
      RateLimitClient['namespaces']['strict']['outgoing']['strict-ping']
    >().toEqualTypeOf<{}>();
  });

  it('has fast-refill namespace', () => {
    expectTypeOf<RateLimitClient['namespaces']>().toHaveProperty('fast-refill');
  });

  it('fast-refill incoming has fast-pong', () => {
    expectTypeOf<
      RateLimitClient['namespaces']['fast-refill']['incoming']['fast-pong']
    >().toEqualTypeOf<{}>();
  });

  it('fast-refill outgoing has fast-ping', () => {
    expectTypeOf<
      RateLimitClient['namespaces']['fast-refill']['outgoing']['fast-ping']
    >().toEqualTypeOf<{}>();
  });
});

describe('RateLimitClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<RateLimitClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<RateLimitClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<RateLimitClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<RateLimitClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<RateLimitClient['errors']>().toHaveProperty('internal-error');
  });
});
