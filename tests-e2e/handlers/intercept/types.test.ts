import { describe, expectTypeOf, it } from 'vitest';
import type { InterceptClient } from './handler.ts';

describe('InterceptClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<InterceptClient['incoming']>().not.toBeAny();
    expectTypeOf<InterceptClient['outgoing']>().not.toBeAny();
    expectTypeOf<InterceptClient['clientRequests']>().not.toBeAny();
    expectTypeOf<InterceptClient['streams']>().not.toBeAny();
    expectTypeOf<InterceptClient['channels']>().not.toBeAny();

    expectTypeOf<InterceptClient['errors']>().not.toBeAny();
  });
});

describe('InterceptClient — top-level incoming (server outgoing)', () => {
  it('has echoed', () => {
    expectTypeOf<InterceptClient['incoming']['echoed']>().toEqualTypeOf<{ text: string }>();
  });

  it('only echoed in top-level incoming', () => {
    expectTypeOf<keyof InterceptClient['incoming']>().toEqualTypeOf<'echoed'>();
  });
});

describe('InterceptClient — top-level outgoing (server incoming)', () => {
  it('has echo', () => {
    expectTypeOf<InterceptClient['outgoing']['echo']>().toEqualTypeOf<{ text: string }>();
  });

  it('only echo in top-level outgoing', () => {
    expectTypeOf<keyof InterceptClient['outgoing']>().toEqualTypeOf<'echo'>();
  });
});

describe('InterceptClient — channels', () => {
  it('addressing: room is static, rooms is a dynamic family', () => {
    expectTypeOf<InterceptClient['channels']['room']['addressing']>().toEqualTypeOf<'static'>();
    expectTypeOf<InterceptClient['channels']['rooms']['addressing']>().toEqualTypeOf<'dynamic'>();
  });

  it('has room channel', () => {
    expectTypeOf<InterceptClient['channels']>().toHaveProperty('room');
  });

  it('room incoming has echoed (server outgoing)', () => {
    expectTypeOf<InterceptClient['channels']['room']['incoming']['echoed']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('room outgoing has echo (server incoming)', () => {
    expectTypeOf<InterceptClient['channels']['room']['outgoing']['echo']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('room streams has ch-nudge-stream', () => {
    expectTypeOf<InterceptClient['channels']['room']['streams']>().toHaveProperty(
      'ch-nudge-stream',
    );
  });
});

describe('InterceptClient — top-level clientRequests', () => {
  it('only intercept-req in top-level clientRequests', () => {
    expectTypeOf<keyof InterceptClient['clientRequests']>().toEqualTypeOf<'intercept-req'>();
  });

  it('intercept-req has correct payload and response', () => {
    expectTypeOf<InterceptClient['clientRequests']['intercept-req']['payload']>().toEqualTypeOf<{
      text: string;
    }>();
    expectTypeOf<InterceptClient['clientRequests']['intercept-req']['response']>().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('InterceptClient — nudge-stream', () => {
  it('top-level streams has nudge-stream', () => {
    expectTypeOf<InterceptClient['streams']>().toHaveProperty('nudge-stream');
  });

  it('nudge-stream chunk is { saw: string }', () => {
    expectTypeOf<InterceptClient['streams']['nudge-stream']['chunk']>().toEqualTypeOf<{
      saw: string;
    }>();
  });

  it('nudge-stream is ephemeral', () => {
    expectTypeOf<InterceptClient['streams']['nudge-stream']['kind']>().toEqualTypeOf<'ephemeral'>();
  });
});

describe('InterceptClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<InterceptClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<InterceptClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<InterceptClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<InterceptClient['errors']>().toHaveProperty('internal-error');
  });
});
