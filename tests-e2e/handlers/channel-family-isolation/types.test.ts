import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelFamilyIsolationClient } from './handler.ts';

describe('ChannelFamilyIsolationClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ChannelFamilyIsolationClient['incoming']>().not.toBeAny();
    expectTypeOf<ChannelFamilyIsolationClient['outgoing']>().not.toBeAny();
    expectTypeOf<ChannelFamilyIsolationClient['clientRequests']>().not.toBeAny();
    expectTypeOf<ChannelFamilyIsolationClient['streams']>().not.toBeAny();
    expectTypeOf<ChannelFamilyIsolationClient['channels']>().not.toBeAny();
    expectTypeOf<ChannelFamilyIsolationClient['errors']>().not.toBeAny();
  });
});

describe('ChannelFamilyIsolationClient — top-level incoming (server outgoing)', () => {
  it('has public-members-result', () => {
    expectTypeOf<
      ChannelFamilyIsolationClient['incoming']['public-members-result']
    >().toEqualTypeOf<{
      name: string;
      count: number;
      ids: string[];
    }>();
  });

  it('has private-members-result', () => {
    expectTypeOf<
      ChannelFamilyIsolationClient['incoming']['private-members-result']
    >().toEqualTypeOf<{
      name: string;
      count: number;
      ids: string[];
    }>();
  });

  it('has kick-acknowledged', () => {
    expectTypeOf<ChannelFamilyIsolationClient['incoming']['kick-acknowledged']>().toEqualTypeOf<{
      where: string;
    }>();
  });

  it('exactly three events in top-level incoming', () => {
    expectTypeOf<keyof ChannelFamilyIsolationClient['incoming']>().toEqualTypeOf<
      'public-members-result' | 'private-members-result' | 'kick-acknowledged'
    >();
  });
});

describe('ChannelFamilyIsolationClient — top-level outgoing (server incoming)', () => {
  it('has public-members', () => {
    expectTypeOf<ChannelFamilyIsolationClient['outgoing']['public-members']>().toEqualTypeOf<{
      name: string;
    }>();
  });

  it('has private-members', () => {
    expectTypeOf<ChannelFamilyIsolationClient['outgoing']['private-members']>().toEqualTypeOf<{
      name: string;
    }>();
  });

  it('has kick-in-public', () => {
    expectTypeOf<ChannelFamilyIsolationClient['outgoing']['kick-in-public']>().toEqualTypeOf<{
      name: string;
      tag: string;
      reason: string;
    }>();
  });

  it('has kick-in-private', () => {
    expectTypeOf<ChannelFamilyIsolationClient['outgoing']['kick-in-private']>().toEqualTypeOf<{
      name: string;
      tag: string;
      reason: string;
    }>();
  });

  it('has public-broadcast-from-top', () => {
    expectTypeOf<
      ChannelFamilyIsolationClient['outgoing']['public-broadcast-from-top']
    >().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });

  it('has public-send-direct', () => {
    expectTypeOf<ChannelFamilyIsolationClient['outgoing']['public-send-direct']>().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });

  it('has private-send-direct', () => {
    expectTypeOf<ChannelFamilyIsolationClient['outgoing']['private-send-direct']>().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });
});

describe('ChannelFamilyIsolationClient — channels', () => {
  it('addressing: publicRooms and privateRooms are dynamic families', () => {
    expectTypeOf<
      ChannelFamilyIsolationClient['channels']['publicRooms']['addressing']
    >().toEqualTypeOf<'dynamic'>();
    expectTypeOf<
      ChannelFamilyIsolationClient['channels']['privateRooms']['addressing']
    >().toEqualTypeOf<'dynamic'>();
  });

  it('has publicRooms channel', () => {
    expectTypeOf<ChannelFamilyIsolationClient['channels']>().toHaveProperty('publicRooms');
  });

  it('has privateRooms channel', () => {
    expectTypeOf<ChannelFamilyIsolationClient['channels']>().toHaveProperty('privateRooms');
  });

  it('publicRooms incoming has room-message (server outgoing)', () => {
    expectTypeOf<
      ChannelFamilyIsolationClient['channels']['publicRooms']['incoming']['room-message']
    >().toEqualTypeOf<{
      family: string;
      name: string;
      text: string;
    }>();
  });

  it('publicRooms outgoing has send-in-public (server incoming)', () => {
    expectTypeOf<
      ChannelFamilyIsolationClient['channels']['publicRooms']['outgoing']['send-in-public']
    >().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });

  it('privateRooms incoming has private-message', () => {
    expectTypeOf<
      ChannelFamilyIsolationClient['channels']['privateRooms']['incoming']['private-message']
    >().toEqualTypeOf<{ family: string; name: string; text: string }>();
  });

  it('privateRooms outgoing has send-in-private', () => {
    expectTypeOf<
      ChannelFamilyIsolationClient['channels']['privateRooms']['outgoing']['send-in-private']
    >().toEqualTypeOf<{ name: string; text: string }>();
  });
});

describe('ChannelFamilyIsolationClient — empty slots', () => {
  it('clientRequests is empty', () => {
    expectTypeOf<keyof ChannelFamilyIsolationClient['clientRequests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ChannelFamilyIsolationClient['streams']>().toBeNever();
  });
});

describe('ChannelFamilyIsolationClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ChannelFamilyIsolationClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ChannelFamilyIsolationClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ChannelFamilyIsolationClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ChannelFamilyIsolationClient['errors']>().toHaveProperty('internal-error');
  });
});
