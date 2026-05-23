import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayMembershipGateClient } from './handler.ts';

describe('ReplayMembershipGateClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ReplayMembershipGateClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['requests']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['streams']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['channels']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['namespaces']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['errors']>().not.toBeAny();
  });
});

describe('ReplayMembershipGateClient — incoming (server outgoing)', () => {
  it('has top-beacon', () => {
    expectTypeOf<ReplayMembershipGateClient['incoming']['top-beacon']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('only top-beacon in top-level incoming', () => {
    expectTypeOf<keyof ReplayMembershipGateClient['incoming']>().toEqualTypeOf<'top-beacon'>();
  });
});

describe('ReplayMembershipGateClient — outgoing (server incoming)', () => {
  it('has send-beacon', () => {
    expectTypeOf<ReplayMembershipGateClient['outgoing']['send-beacon']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('only send-beacon in outgoing', () => {
    expectTypeOf<keyof ReplayMembershipGateClient['outgoing']>().toEqualTypeOf<'send-beacon'>();
  });
});

describe('ReplayMembershipGateClient — channels', () => {
  it('has private channel', () => {
    expectTypeOf<ReplayMembershipGateClient['channels']>().toHaveProperty('private');
  });

  it('private incoming has secret (server outgoing)', () => {
    expectTypeOf<
      ReplayMembershipGateClient['channels']['private']['incoming']['secret']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('private outgoing has send-secret (server incoming)', () => {
    expectTypeOf<
      ReplayMembershipGateClient['channels']['private']['outgoing']['send-secret']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('ReplayMembershipGateClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof ReplayMembershipGateClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ReplayMembershipGateClient['streams']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof ReplayMembershipGateClient['namespaces']>().toBeNever();
  });
});

describe('ReplayMembershipGateClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ReplayMembershipGateClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ReplayMembershipGateClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ReplayMembershipGateClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ReplayMembershipGateClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ReplayMembershipGateClient['errors']>().toHaveProperty('internal-error');
  });
});
