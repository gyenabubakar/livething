import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelScopeIsolationClient } from './handler.ts';

describe('ChannelScopeIsolationClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ChannelScopeIsolationClient['incoming']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['outgoing']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['requests']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['streams']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['channels']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['namespaces']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['errors']>().not.toBeAny();
  });
});

describe('ChannelScopeIsolationClient — top-level incoming (server outgoing)', () => {
  it('has public-members-result', () => {
    expectTypeOf<ChannelScopeIsolationClient['incoming']['public-members-result']>().toEqualTypeOf<{
      name: string;
      count: number;
      ids: string[];
    }>();
  });

  it('has private-members-result', () => {
    expectTypeOf<
      ChannelScopeIsolationClient['incoming']['private-members-result']
    >().toEqualTypeOf<{
      name: string;
      count: number;
      ids: string[];
    }>();
  });

  it('has kick-acknowledged', () => {
    expectTypeOf<ChannelScopeIsolationClient['incoming']['kick-acknowledged']>().toEqualTypeOf<{
      where: string;
    }>();
  });

  it('exactly three events in top-level incoming', () => {
    expectTypeOf<keyof ChannelScopeIsolationClient['incoming']>().toEqualTypeOf<
      'public-members-result' | 'private-members-result' | 'kick-acknowledged'
    >();
  });
});

describe('ChannelScopeIsolationClient — top-level outgoing (server incoming)', () => {
  it('has public-members', () => {
    expectTypeOf<ChannelScopeIsolationClient['outgoing']['public-members']>().toEqualTypeOf<{
      name: string;
    }>();
  });

  it('has private-members', () => {
    expectTypeOf<ChannelScopeIsolationClient['outgoing']['private-members']>().toEqualTypeOf<{
      name: string;
    }>();
  });

  it('has kick-in-public', () => {
    expectTypeOf<ChannelScopeIsolationClient['outgoing']['kick-in-public']>().toEqualTypeOf<{
      name: string;
      tag: string;
      reason: string;
    }>();
  });

  it('has kick-in-private', () => {
    expectTypeOf<ChannelScopeIsolationClient['outgoing']['kick-in-private']>().toEqualTypeOf<{
      name: string;
      tag: string;
      reason: string;
    }>();
  });

  it('has public-broadcast-from-top', () => {
    expectTypeOf<
      ChannelScopeIsolationClient['outgoing']['public-broadcast-from-top']
    >().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });

  it('has public-send-direct', () => {
    expectTypeOf<ChannelScopeIsolationClient['outgoing']['public-send-direct']>().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });

  it('has private-send-direct', () => {
    expectTypeOf<ChannelScopeIsolationClient['outgoing']['private-send-direct']>().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });
});

describe('ChannelScopeIsolationClient — channels', () => {
  it('has publicRooms channel', () => {
    expectTypeOf<ChannelScopeIsolationClient['channels']>().toHaveProperty('publicRooms');
  });

  it('has privateRooms channel', () => {
    expectTypeOf<ChannelScopeIsolationClient['channels']>().toHaveProperty('privateRooms');
  });

  it('publicRooms incoming has room-message (server outgoing)', () => {
    expectTypeOf<
      ChannelScopeIsolationClient['channels']['publicRooms']['incoming']['room-message']
    >().toEqualTypeOf<{
      family: string;
      name: string;
      text: string;
    }>();
  });

  it('publicRooms outgoing has send-in-public (server incoming)', () => {
    expectTypeOf<
      ChannelScopeIsolationClient['channels']['publicRooms']['outgoing']['send-in-public']
    >().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });

  it('privateRooms incoming has private-message', () => {
    expectTypeOf<
      ChannelScopeIsolationClient['channels']['privateRooms']['incoming']['private-message']
    >().toEqualTypeOf<{ family: string; name: string; text: string }>();
  });

  it('privateRooms outgoing has send-in-private', () => {
    expectTypeOf<
      ChannelScopeIsolationClient['channels']['privateRooms']['outgoing']['send-in-private']
    >().toEqualTypeOf<{ name: string; text: string }>();
  });
});

describe('ChannelScopeIsolationClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof ChannelScopeIsolationClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ChannelScopeIsolationClient['streams']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof ChannelScopeIsolationClient['namespaces']>().toBeNever();
  });
});

describe('ChannelScopeIsolationClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ChannelScopeIsolationClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ChannelScopeIsolationClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ChannelScopeIsolationClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ChannelScopeIsolationClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ChannelScopeIsolationClient['errors']>().toHaveProperty('internal-error');
  });
});
