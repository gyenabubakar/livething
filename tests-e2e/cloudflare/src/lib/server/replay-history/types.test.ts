import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayClient } from './handler.ts';

describe('ReplayClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ReplayClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplayClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplayClient['requests']>().not.toBeAny();
    expectTypeOf<ReplayClient['streams']>().not.toBeAny();
    expectTypeOf<ReplayClient['channels']>().not.toBeAny();
    expectTypeOf<ReplayClient['namespaces']>().not.toBeAny();
    expectTypeOf<ReplayClient['errors']>().not.toBeAny();
  });
});

describe('ReplayClient — incoming (server outgoing)', () => {
  it('has chat-msg', () => {
    expectTypeOf<ReplayClient['incoming']['chat-msg']>().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('has cursor', () => {
    expectTypeOf<ReplayClient['incoming']['cursor']>().toEqualTypeOf<{
      x: number;
      y: number;
    }>();
  });

  it('has room-msg', () => {
    expectTypeOf<ReplayClient['incoming']['room-msg']>().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('has replay-guard-error', () => {
    expectTypeOf<ReplayClient['incoming']['replay-guard-error']>().toEqualTypeOf<{
      undeclared: string;
    }>();
  });

  it('exactly four events in top-level incoming', () => {
    expectTypeOf<keyof ReplayClient['incoming']>().toEqualTypeOf<
      'chat-msg' | 'cursor' | 'room-msg' | 'replay-guard-error'
    >();
  });
});

describe('ReplayClient — outgoing (server incoming)', () => {
  it('has send-msg', () => {
    expectTypeOf<ReplayClient['outgoing']['send-msg']>().toEqualTypeOf<{ text: string }>();
  });

  it('has send-cursor', () => {
    expectTypeOf<ReplayClient['outgoing']['send-cursor']>().toEqualTypeOf<{
      x: number;
      y: number;
    }>();
  });

  it('has request-history with empty payload', () => {
    expectTypeOf<ReplayClient['outgoing']['request-history']>().toEqualTypeOf<{}>();
  });

  it('has trigger-bad-replay with empty payload', () => {
    expectTypeOf<ReplayClient['outgoing']['trigger-bad-replay']>().toEqualTypeOf<{}>();
  });

  it('has inject-family-replay with empty payload', () => {
    expectTypeOf<ReplayClient['outgoing']['inject-family-replay']>().toEqualTypeOf<{}>();
  });

  it('has trigger-bigint-replay with empty payload', () => {
    expectTypeOf<ReplayClient['outgoing']['trigger-bigint-replay']>().toEqualTypeOf<{}>();
  });
});

describe('ReplayClient — requests', () => {
  it('has get-token', () => {
    expectTypeOf<ReplayClient['requests']>().toHaveProperty('get-token');
  });

  it('get-token has correct payload and response', () => {
    expectTypeOf<ReplayClient['requests']['get-token']['payload']>().toEqualTypeOf<{}>();
    expectTypeOf<ReplayClient['requests']['get-token']['response']>().toEqualTypeOf<{
      token: string;
    }>();
  });
});

describe('ReplayClient — streams', () => {
  it('has start-tiny-stream', () => {
    expectTypeOf<ReplayClient['streams']>().toHaveProperty('start-tiny-stream');
  });

  it('start-tiny-stream has correct payload and chunk', () => {
    expectTypeOf<ReplayClient['streams']['start-tiny-stream']['payload']>().toEqualTypeOf<{}>();
    expectTypeOf<ReplayClient['streams']['start-tiny-stream']['chunk']>().toEqualTypeOf<{
      value: string;
    }>();
  });

  it('start-tiny-stream has no cursor or nudges', () => {
    expectTypeOf<ReplayClient['streams']['start-tiny-stream']>().not.toHaveProperty('cursor');
    expectTypeOf<ReplayClient['streams']['start-tiny-stream']>().not.toHaveProperty('nudges');
    expectTypeOf<ReplayClient['streams']['start-tiny-stream']>().not.toHaveProperty('broadcast');
  });
});

describe('ReplayClient — stream resumable flags', () => {
  it('start-tiny-stream is not resumable', () => {
    expectTypeOf<
      ReplayClient['streams']['start-tiny-stream']['resumable']
    >().toEqualTypeOf<false>();
  });
});

describe('ReplayClient — namespaces', () => {
  it('has admin namespace', () => {
    expectTypeOf<ReplayClient['namespaces']>().toHaveProperty('admin');
  });

  it('admin incoming has chat-msg (server outgoing)', () => {
    expectTypeOf<ReplayClient['namespaces']['admin']['incoming']['chat-msg']>().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('admin outgoing has send-admin-msg', () => {
    expectTypeOf<
      ReplayClient['namespaces']['admin']['outgoing']['send-admin-msg']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('ReplayClient — channels', () => {
  it('has replay-room channel', () => {
    expectTypeOf<ReplayClient['channels']>().toHaveProperty('replay-room');
  });

  it('replay-room incoming has room-msg', () => {
    expectTypeOf<ReplayClient['channels']['replay-room']['incoming']['room-msg']>().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('replay-room outgoing has send-room-msg', () => {
    expectTypeOf<
      ReplayClient['channels']['replay-room']['outgoing']['send-room-msg']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('replay-room outgoing has request-room-history', () => {
    expectTypeOf<
      ReplayClient['channels']['replay-room']['outgoing']['request-room-history']
    >().toEqualTypeOf<{}>();
  });

  it('has fams channel', () => {
    expectTypeOf<ReplayClient['channels']>().toHaveProperty('fams');
  });

  it('fams incoming has room-msg', () => {
    expectTypeOf<ReplayClient['channels']['fams']['incoming']['room-msg']>().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('fams outgoing has send-room-msg', () => {
    expectTypeOf<ReplayClient['channels']['fams']['outgoing']['send-room-msg']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('has optout-room channel', () => {
    expectTypeOf<ReplayClient['channels']>().toHaveProperty('optout-room');
  });

  it('optout-room incoming has room-msg', () => {
    expectTypeOf<ReplayClient['channels']['optout-room']['incoming']['room-msg']>().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('optout-room outgoing has send-room-msg', () => {
    expectTypeOf<
      ReplayClient['channels']['optout-room']['outgoing']['send-room-msg']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('exactly three channels', () => {
    expectTypeOf<keyof ReplayClient['channels']>().toEqualTypeOf<
      'replay-room' | 'fams' | 'optout-room'
    >();
  });
});

describe('ReplayClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ReplayClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ReplayClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ReplayClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ReplayClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ReplayClient['errors']>().toHaveProperty('internal-error');
  });
});
