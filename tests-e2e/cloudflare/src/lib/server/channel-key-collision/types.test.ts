import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelKeyCollisionClient } from './handler.ts';

describe('ChannelKeyCollisionClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ChannelKeyCollisionClient['incoming']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['outgoing']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['requests']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['streams']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['channels']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['namespaces']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['errors']>().not.toBeAny();
  });
});

describe('ChannelKeyCollisionClient — top-level incoming (server outgoing)', () => {
  it('has members-result', () => {
    expectTypeOf<ChannelKeyCollisionClient['incoming']['members-result']>().toEqualTypeOf<{
      family: string;
      name: string;
      count: number;
    }>();
  });

  it('only members-result in incoming', () => {
    expectTypeOf<keyof ChannelKeyCollisionClient['incoming']>().toEqualTypeOf<'members-result'>();
  });
});

describe('ChannelKeyCollisionClient — top-level outgoing (server incoming)', () => {
  it('has broadcast-a', () => {
    expectTypeOf<ChannelKeyCollisionClient['outgoing']['broadcast-a']>().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });

  it('has broadcast-b', () => {
    expectTypeOf<ChannelKeyCollisionClient['outgoing']['broadcast-b']>().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });

  it('has members-a', () => {
    expectTypeOf<ChannelKeyCollisionClient['outgoing']['members-a']>().toEqualTypeOf<{
      name: string;
    }>();
  });

  it('has members-b', () => {
    expectTypeOf<ChannelKeyCollisionClient['outgoing']['members-b']>().toEqualTypeOf<{
      name: string;
    }>();
  });

  it('exactly four events in outgoing', () => {
    expectTypeOf<keyof ChannelKeyCollisionClient['outgoing']>().toEqualTypeOf<
      'broadcast-a' | 'broadcast-b' | 'members-a' | 'members-b'
    >();
  });
});

describe('ChannelKeyCollisionClient — channels', () => {
  it('has rooms channel', () => {
    expectTypeOf<ChannelKeyCollisionClient['channels']>().toHaveProperty('rooms');
  });

  it('has rooms::private channel', () => {
    expectTypeOf<ChannelKeyCollisionClient['channels']>().toHaveProperty('rooms::private');
  });

  it('rooms channel incoming has hello (server outgoing)', () => {
    expectTypeOf<
      ChannelKeyCollisionClient['channels']['rooms']['incoming']['hello']
    >().toEqualTypeOf<{
      family: string;
      name: string;
      text: string;
    }>();
  });

  it('rooms channel outgoing is empty (no incoming declared in rooms scope)', () => {
    expectTypeOf<keyof ChannelKeyCollisionClient['channels']['rooms']['outgoing']>().toBeNever();
  });

  it('rooms::private channel incoming has hello', () => {
    expectTypeOf<
      ChannelKeyCollisionClient['channels']['rooms::private']['incoming']['hello']
    >().toEqualTypeOf<{ family: string; name: string; text: string }>();
  });
});

describe('ChannelKeyCollisionClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof ChannelKeyCollisionClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ChannelKeyCollisionClient['streams']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof ChannelKeyCollisionClient['namespaces']>().toBeNever();
  });
});

describe('ChannelKeyCollisionClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ChannelKeyCollisionClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ChannelKeyCollisionClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ChannelKeyCollisionClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ChannelKeyCollisionClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ChannelKeyCollisionClient['errors']>().toHaveProperty('internal-error');
  });
});
