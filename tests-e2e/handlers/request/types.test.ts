import { describe, expectTypeOf, it } from 'vitest';
import type { RequestClient } from './handler.ts';

describe('RequestClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<RequestClient['incoming']>().not.toBeAny();
    expectTypeOf<RequestClient['outgoing']>().not.toBeAny();
    expectTypeOf<RequestClient['requests']>().not.toBeAny();
    expectTypeOf<RequestClient['streams']>().not.toBeAny();
    expectTypeOf<RequestClient['channels']>().not.toBeAny();
    expectTypeOf<RequestClient['errors']>().not.toBeAny();
  });
});

describe('RequestClient — top-level requests', () => {
  it('has get-time', () => {
    expectTypeOf<RequestClient['requests']>().toHaveProperty('get-time');
  });

  it('get-time has correct payload and response', () => {
    expectTypeOf<RequestClient['requests']['get-time']['payload']>().toEqualTypeOf<{}>();
    expectTypeOf<RequestClient['requests']['get-time']['response']>().toEqualTypeOf<{
      now: string;
    }>();
  });

  it('has no-response request', () => {
    expectTypeOf<RequestClient['requests']>().toHaveProperty('no-response');
  });

  it('no-response has correct payload and response', () => {
    expectTypeOf<RequestClient['requests']['no-response']['payload']>().toEqualTypeOf<{}>();
    expectTypeOf<RequestClient['requests']['no-response']['response']>().toEqualTypeOf<{
      ok: boolean;
    }>();
  });

  it('has double-response request', () => {
    expectTypeOf<RequestClient['requests']>().toHaveProperty('double-response');
  });

  it('double-response has correct response', () => {
    expectTypeOf<RequestClient['requests']['double-response']['response']>().toEqualTypeOf<{
      count: number;
    }>();
  });

  it('has strict-echo request', () => {
    expectTypeOf<RequestClient['requests']>().toHaveProperty('strict-echo');
  });

  it('strict-echo payload is strict', () => {
    expectTypeOf<RequestClient['requests']['strict-echo']['payload']>().toEqualTypeOf<{
      id: string;
    }>();
  });

  it('strict-echo response is correct', () => {
    expectTypeOf<RequestClient['requests']['strict-echo']['response']>().toEqualTypeOf<{
      echoed: string;
    }>();
  });

  it('has throwing-request', () => {
    expectTypeOf<RequestClient['requests']>().toHaveProperty('throwing-request');
  });

  it('has the declared top-level requests', () => {
    expectTypeOf<keyof RequestClient['requests']>().toEqualTypeOf<
      | 'get-time'
      | 'no-response'
      | 'double-response'
      | 'strict-echo'
      | 'throwing-request'
      | 'echo-anything-req'
      | 'hang'
    >();
  });
});

describe('RequestClient — channels', () => {
  it('addressing: room is a static channel', () => {
    expectTypeOf<RequestClient['channels']['room']['addressing']>().toEqualTypeOf<'static'>();
  });

  it('has room channel', () => {
    expectTypeOf<RequestClient['channels']>().toHaveProperty('room');
  });

  it('room requests has get-channel-info', () => {
    expectTypeOf<RequestClient['channels']['room']['requests']>().toHaveProperty(
      'get-channel-info',
    );
  });

  it('get-channel-info has correct payload and response', () => {
    expectTypeOf<
      RequestClient['channels']['room']['requests']['get-channel-info']['payload']
    >().toEqualTypeOf<{}>();
    expectTypeOf<
      RequestClient['channels']['room']['requests']['get-channel-info']['response']
    >().toEqualTypeOf<{
      channel: string;
    }>();
  });

  it('room incoming and outgoing are empty', () => {
    expectTypeOf<keyof RequestClient['channels']['room']['incoming']>().toBeNever();
    expectTypeOf<keyof RequestClient['channels']['room']['outgoing']>().toBeNever();
  });
});

describe('RequestClient — empty slots', () => {
  it('top-level incoming is empty', () => {
    expectTypeOf<keyof RequestClient['incoming']>().toBeNever();
  });

  it('top-level outgoing is empty', () => {
    expectTypeOf<keyof RequestClient['outgoing']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof RequestClient['streams']>().toBeNever();
  });
});

describe('RequestClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<RequestClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<RequestClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<RequestClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<RequestClient['errors']>().toHaveProperty('internal-error');
  });
});
