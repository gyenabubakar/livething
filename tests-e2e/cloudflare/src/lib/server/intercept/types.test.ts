import { describe, expectTypeOf, it } from 'vitest';
import type { InterceptClient } from './handler.ts';

describe('InterceptClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<InterceptClient['incoming']>().not.toBeAny();
    expectTypeOf<InterceptClient['outgoing']>().not.toBeAny();
    expectTypeOf<InterceptClient['requests']>().not.toBeAny();
    expectTypeOf<InterceptClient['streams']>().not.toBeAny();
    expectTypeOf<InterceptClient['channels']>().not.toBeAny();
    expectTypeOf<InterceptClient['namespaces']>().not.toBeAny();
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

describe('InterceptClient — namespaces', () => {
  it('has ns namespace', () => {
    expectTypeOf<InterceptClient['namespaces']>().toHaveProperty('ns');
  });

  it('ns incoming has echoed (server outgoing → client receives)', () => {
    expectTypeOf<InterceptClient['namespaces']['ns']['incoming']['echoed']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('ns outgoing has echo (server incoming → client sends)', () => {
    expectTypeOf<InterceptClient['namespaces']['ns']['outgoing']['echo']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('ns streams has intercepted-stream', () => {
    expectTypeOf<InterceptClient['namespaces']['ns']['streams']>().toHaveProperty(
      'intercepted-stream',
    );
  });

  it('ns streams has ns-nudge-stream', () => {
    expectTypeOf<InterceptClient['namespaces']['ns']['streams']>().toHaveProperty(
      'ns-nudge-stream',
    );
  });

  it('intercepted-stream has correct payload and chunk', () => {
    expectTypeOf<
      InterceptClient['namespaces']['ns']['streams']['intercepted-stream']['payload']
    >().toEqualTypeOf<{
      text: string;
    }>();
    expectTypeOf<
      InterceptClient['namespaces']['ns']['streams']['intercepted-stream']['chunk']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('intercepted-stream has no cursor or nudges', () => {
    expectTypeOf<
      InterceptClient['namespaces']['ns']['streams']['intercepted-stream']
    >().not.toHaveProperty('cursor');
    expectTypeOf<
      InterceptClient['namespaces']['ns']['streams']['intercepted-stream']
    >().not.toHaveProperty('nudges');
    expectTypeOf<
      InterceptClient['namespaces']['ns']['streams']['intercepted-stream']
    >().not.toHaveProperty('broadcast');
  });
});

describe('InterceptClient — stream kind', () => {
  it('intercepted-stream is ephemeral', () => {
    expectTypeOf<
      InterceptClient['namespaces']['ns']['streams']['intercepted-stream']['kind']
    >().toEqualTypeOf<'ephemeral'>();
  });
});

describe('InterceptClient — channels', () => {
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

describe('InterceptClient — top-level requests', () => {
  it('only intercept-req in top-level requests', () => {
    expectTypeOf<keyof InterceptClient['requests']>().toEqualTypeOf<'intercept-req'>();
  });

  it('intercept-req has correct payload and response', () => {
    expectTypeOf<InterceptClient['requests']['intercept-req']['payload']>().toEqualTypeOf<{
      text: string;
    }>();
    expectTypeOf<InterceptClient['requests']['intercept-req']['response']>().toEqualTypeOf<{
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
    expectTypeOf<InterceptClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<InterceptClient['errors']>().toHaveProperty('internal-error');
  });
});
