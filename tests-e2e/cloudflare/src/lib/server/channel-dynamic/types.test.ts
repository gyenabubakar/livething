import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelDynamicClient } from './handler.ts';

describe('ChannelDynamicClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ChannelDynamicClient['incoming']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['outgoing']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['requests']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['streams']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['channels']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['namespaces']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['errors']>().not.toBeAny();
  });
});

describe('ChannelDynamicClient — top-level incoming (server outgoing)', () => {
  it('has top-only-action-fired', () => {
    expectTypeOf<ChannelDynamicClient['incoming']['top-only-action-fired']>().toEqualTypeOf<{
      from: string;
    }>();
  });

  it('has validation-observed', () => {
    expectTypeOf<ChannelDynamicClient['incoming']['validation-observed']>().toEqualTypeOf<{
      channel: string;
      event: string;
    }>();
  });

  it('has scoped-error-observed', () => {
    expectTypeOf<ChannelDynamicClient['incoming']['scoped-error-observed']>().toEqualTypeOf<{
      channel: string;
      scope: string;
      event: string;
    }>();
  });

  it('exactly three events in top-level incoming', () => {
    expectTypeOf<keyof ChannelDynamicClient['incoming']>().toEqualTypeOf<
      'top-only-action-fired' | 'validation-observed' | 'scoped-error-observed'
    >();
  });
});

describe('ChannelDynamicClient — top-level outgoing (server incoming)', () => {
  it('has top-only-action with empty payload', () => {
    expectTypeOf<ChannelDynamicClient['outgoing']['top-only-action']>().toEqualTypeOf<{}>();
  });

  it('has trigger-server-subscribe-dynamic', () => {
    expectTypeOf<
      ChannelDynamicClient['outgoing']['trigger-server-subscribe-dynamic']
    >().toEqualTypeOf<{ name: string }>();
  });

  it('exactly two events in top-level outgoing', () => {
    expectTypeOf<keyof ChannelDynamicClient['outgoing']>().toEqualTypeOf<
      'top-only-action' | 'trigger-server-subscribe-dynamic'
    >();
  });
});

describe('ChannelDynamicClient — channels', () => {
  it('has room channel', () => {
    expectTypeOf<ChannelDynamicClient['channels']>().toHaveProperty('room');
  });

  it('has proto-probe channel', () => {
    expectTypeOf<ChannelDynamicClient['channels']>().toHaveProperty('proto-probe');
  });

  it('room channel incoming has room-message (server outgoing → client receives)', () => {
    expectTypeOf<
      ChannelDynamicClient['channels']['room']['incoming']['room-message']
    >().toEqualTypeOf<{
      channel: string;
      text: string;
      from: string;
      kind: string;
    }>();
  });

  it('room channel incoming has name-result', () => {
    expectTypeOf<
      ChannelDynamicClient['channels']['room']['incoming']['name-result']
    >().toEqualTypeOf<{
      name: string;
      suffix: string;
    }>();
  });

  it('room channel outgoing has send-message (server incoming → client sends)', () => {
    expectTypeOf<
      ChannelDynamicClient['channels']['room']['outgoing']['send-message']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('room channel outgoing has echo-name', () => {
    expectTypeOf<
      ChannelDynamicClient['channels']['room']['outgoing']['echo-name']
    >().toEqualTypeOf<{}>();
  });

  it('room channel outgoing has trigger-manual-validation', () => {
    expectTypeOf<
      ChannelDynamicClient['channels']['room']['outgoing']['trigger-manual-validation']
    >().toEqualTypeOf<{}>();
  });

  it('room channel outgoing has trigger-scoped-error', () => {
    expectTypeOf<
      ChannelDynamicClient['channels']['room']['outgoing']['trigger-scoped-error']
    >().toEqualTypeOf<{}>();
  });

  it('proto-probe channel has no incoming or outgoing', () => {
    expectTypeOf<keyof ChannelDynamicClient['channels']['proto-probe']['incoming']>().toBeNever();
    expectTypeOf<keyof ChannelDynamicClient['channels']['proto-probe']['outgoing']>().toBeNever();
  });
});

describe('ChannelDynamicClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof ChannelDynamicClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ChannelDynamicClient['streams']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof ChannelDynamicClient['namespaces']>().toBeNever();
  });
});

describe('ChannelDynamicClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ChannelDynamicClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ChannelDynamicClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ChannelDynamicClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ChannelDynamicClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ChannelDynamicClient['errors']>().toHaveProperty('internal-error');
  });
});
