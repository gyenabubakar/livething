import { describe, expectTypeOf, it } from 'vitest';
import type { CtxSendClient } from './handler.ts';

describe('CtxSendClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<CtxSendClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxSendClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxSendClient['requests']>().not.toBeAny();
    expectTypeOf<CtxSendClient['streams']>().not.toBeAny();
    expectTypeOf<CtxSendClient['channels']>().not.toBeAny();
    expectTypeOf<CtxSendClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxSendClient['errors']>().not.toBeAny();
  });
});

describe('CtxSendClient — incoming (server outgoing)', () => {
  it('has message', () => {
    expectTypeOf<CtxSendClient['incoming']['message']>().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('has who-am-i-result', () => {
    expectTypeOf<CtxSendClient['incoming']['who-am-i-result']>().toEqualTypeOf<{
      connectionId: string;
    }>();
  });

  it('has delivery-status', () => {
    expectTypeOf<CtxSendClient['incoming']['delivery-status']>().toEqualTypeOf<{
      delivered: boolean;
    }>();
  });

  it('exactly three events in incoming', () => {
    expectTypeOf<keyof CtxSendClient['incoming']>().toEqualTypeOf<
      'message' | 'who-am-i-result' | 'delivery-status'
    >();
  });
});

describe('CtxSendClient — outgoing (server incoming)', () => {
  it('has do-broadcast', () => {
    expectTypeOf<CtxSendClient['outgoing']['do-broadcast']>().toEqualTypeOf<{ text: string }>();
  });

  it('has do-broadcast-exclude-self', () => {
    expectTypeOf<CtxSendClient['outgoing']['do-broadcast-exclude-self']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('has do-send-to', () => {
    expectTypeOf<CtxSendClient['outgoing']['do-send-to']>().toEqualTypeOf<{
      tag: string;
      text: string;
    }>();
  });

  it('has do-send-to-empty', () => {
    expectTypeOf<CtxSendClient['outgoing']['do-send-to-empty']>().toEqualTypeOf<{ text: string }>();
  });

  it('has do-send-to-connection', () => {
    expectTypeOf<CtxSendClient['outgoing']['do-send-to-connection']>().toEqualTypeOf<{
      connectionId: string;
      text: string;
    }>();
  });

  it('has who-am-i', () => {
    expectTypeOf<CtxSendClient['outgoing']['who-am-i']>().toEqualTypeOf<{}>();
  });

  it('has do-server-close', () => {
    expectTypeOf<CtxSendClient['outgoing']['do-server-close']>().toEqualTypeOf<{}>();
  });

  it('exactly seven events in outgoing', () => {
    expectTypeOf<keyof CtxSendClient['outgoing']>().toEqualTypeOf<
      | 'do-broadcast'
      | 'do-broadcast-exclude-self'
      | 'do-send-to'
      | 'do-send-to-empty'
      | 'do-send-to-connection'
      | 'who-am-i'
      | 'do-server-close'
    >();
  });
});

describe('CtxSendClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof CtxSendClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof CtxSendClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof CtxSendClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof CtxSendClient['namespaces']>().toBeNever();
  });
});

describe('CtxSendClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<CtxSendClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<CtxSendClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<CtxSendClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<CtxSendClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<CtxSendClient['errors']>().toHaveProperty('internal-error');
  });
});
