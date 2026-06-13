import { describe, expectTypeOf, it } from 'vitest';
import type { CtxMetaClient } from './handler.ts';

describe('CtxMetaClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<CtxMetaClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxMetaClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxMetaClient['requests']>().not.toBeAny();
    expectTypeOf<CtxMetaClient['streams']>().not.toBeAny();
    expectTypeOf<CtxMetaClient['channels']>().not.toBeAny();
    expectTypeOf<CtxMetaClient['errors']>().not.toBeAny();
  });
});

describe('CtxMetaClient — incoming (server outgoing)', () => {
  it('has who-am-i-result', () => {
    expectTypeOf<CtxMetaClient['incoming']['who-am-i-result']>().toEqualTypeOf<{
      username: string;
    }>();
  });

  it('has members-list-result', () => {
    expectTypeOf<CtxMetaClient['incoming']['members-list-result']>().toEqualTypeOf<{
      members: string[];
    }>();
  });

  it('has broadcast-identity-received', () => {
    expectTypeOf<CtxMetaClient['incoming']['broadcast-identity-received']>().toEqualTypeOf<{
      from: string;
    }>();
  });

  it('exactly three events in incoming', () => {
    expectTypeOf<keyof CtxMetaClient['incoming']>().toEqualTypeOf<
      'who-am-i-result' | 'members-list-result' | 'broadcast-identity-received'
    >();
  });
});

describe('CtxMetaClient — outgoing (server incoming)', () => {
  it('has who-am-i with empty payload', () => {
    expectTypeOf<CtxMetaClient['outgoing']['who-am-i']>().toEqualTypeOf<{}>();
  });

  it('has list-members with empty payload', () => {
    expectTypeOf<CtxMetaClient['outgoing']['list-members']>().toEqualTypeOf<{}>();
  });

  it('has broadcast-identity with empty payload', () => {
    expectTypeOf<CtxMetaClient['outgoing']['broadcast-identity']>().toEqualTypeOf<{}>();
  });

  it('exactly three events in outgoing', () => {
    expectTypeOf<keyof CtxMetaClient['outgoing']>().toEqualTypeOf<
      'who-am-i' | 'list-members' | 'broadcast-identity'
    >();
  });
});

describe('CtxMetaClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof CtxMetaClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof CtxMetaClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof CtxMetaClient['channels']>().toBeNever();
  });
});

describe('CtxMetaClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<CtxMetaClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<CtxMetaClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<CtxMetaClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<CtxMetaClient['errors']>().toHaveProperty('internal-error');
  });
});
