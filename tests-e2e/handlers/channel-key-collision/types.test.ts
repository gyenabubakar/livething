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

describe('ChannelKeyCollisionClient — top-level outgoing (server incoming)', () => {
  it('has broadcast-a and broadcast-b', () => {
    expectTypeOf<ChannelKeyCollisionClient['outgoing']['broadcast-a']>().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
    expectTypeOf<ChannelKeyCollisionClient['outgoing']['broadcast-b']>().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });

  it('exactly two outgoing events', () => {
    expectTypeOf<keyof ChannelKeyCollisionClient['outgoing']>().toEqualTypeOf<
      'broadcast-a' | 'broadcast-b'
    >();
  });
});

describe('ChannelKeyCollisionClient — channel families', () => {
  it('addressing: both keys are dynamic families', () => {
    expectTypeOf<
      ChannelKeyCollisionClient['channels']['rooms']['addressing']
    >().toEqualTypeOf<'dynamic'>();
    expectTypeOf<
      ChannelKeyCollisionClient['channels']['rooms-private']['addressing']
    >().toEqualTypeOf<'dynamic'>();
  });

  it('has both families', () => {
    expectTypeOf<keyof ChannelKeyCollisionClient['channels']>().toEqualTypeOf<
      'rooms' | 'rooms-private'
    >();
  });

  it('each family declares the hello incoming event', () => {
    expectTypeOf<
      ChannelKeyCollisionClient['channels']['rooms']['incoming']['hello']
    >().toEqualTypeOf<{
      family: string;
      text: string;
    }>();
    expectTypeOf<
      ChannelKeyCollisionClient['channels']['rooms-private']['incoming']['hello']
    >().toEqualTypeOf<{
      family: string;
      text: string;
    }>();
  });
});
