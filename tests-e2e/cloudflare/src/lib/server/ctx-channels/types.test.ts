import { describe, expectTypeOf, it } from 'vitest';
import type { CtxChannelsClient } from './handler.ts';

describe('CtxChannelsClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<CtxChannelsClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['requests']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['streams']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['channels']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['errors']>().not.toBeAny();
  });
});

describe('CtxChannelsClient — top-level incoming (server outgoing)', () => {
  it('has members-result', () => {
    expectTypeOf<CtxChannelsClient['incoming']['members-result']>().toEqualTypeOf<{
      channel: string;
      count: number;
    }>();
  });

  it('has member-id-result', () => {
    expectTypeOf<CtxChannelsClient['incoming']['member-id-result']>().toEqualTypeOf<{
      id: string;
    }>();
  });

  it('exactly two events in incoming', () => {
    expectTypeOf<keyof CtxChannelsClient['incoming']>().toEqualTypeOf<
      'members-result' | 'member-id-result'
    >();
  });
});

describe('CtxChannelsClient — top-level outgoing (server incoming)', () => {
  it('has get-members', () => {
    expectTypeOf<CtxChannelsClient['outgoing']['get-members']>().toEqualTypeOf<{
      channel: string;
    }>();
  });

  it('has get-member-id', () => {
    expectTypeOf<CtxChannelsClient['outgoing']['get-member-id']>().toEqualTypeOf<{
      channel: string;
    }>();
  });

  it('has kick-in-channel', () => {
    expectTypeOf<CtxChannelsClient['outgoing']['kick-in-channel']>().toEqualTypeOf<{
      channel: string;
      tag: string;
      reason: string;
    }>();
  });

  it('has kick-nonmember', () => {
    expectTypeOf<CtxChannelsClient['outgoing']['kick-nonmember']>().toEqualTypeOf<{}>();
  });

  it('exactly four events in outgoing', () => {
    expectTypeOf<keyof CtxChannelsClient['outgoing']>().toEqualTypeOf<
      'get-members' | 'get-member-id' | 'kick-in-channel' | 'kick-nonmember'
    >();
  });
});

describe('CtxChannelsClient — channels', () => {
  it('has room channel', () => {
    expectTypeOf<CtxChannelsClient['channels']>().toHaveProperty('room');
  });

  it('room incoming has room-message (server outgoing)', () => {
    expectTypeOf<
      CtxChannelsClient['channels']['room']['incoming']['room-message']
    >().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('room outgoing has send-room-message (server incoming)', () => {
    expectTypeOf<
      CtxChannelsClient['channels']['room']['outgoing']['send-room-message']
    >().toEqualTypeOf<{ text: string }>();
  });
});

describe('CtxChannelsClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof CtxChannelsClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof CtxChannelsClient['streams']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof CtxChannelsClient['namespaces']>().toBeNever();
  });
});

describe('CtxChannelsClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<CtxChannelsClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<CtxChannelsClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<CtxChannelsClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<CtxChannelsClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<CtxChannelsClient['errors']>().toHaveProperty('internal-error');
  });
});
