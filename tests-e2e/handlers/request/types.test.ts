import { describe, expectTypeOf, it } from 'vitest';
import type { RequestClient } from './handler.ts';

describe('RequestClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<RequestClient['incoming']>().not.toBeAny();
    expectTypeOf<RequestClient['outgoing']>().not.toBeAny();
    expectTypeOf<RequestClient['clientRequests']>().not.toBeAny();
    expectTypeOf<RequestClient['streams']>().not.toBeAny();
    expectTypeOf<RequestClient['channels']>().not.toBeAny();
    expectTypeOf<RequestClient['errors']>().not.toBeAny();
  });
});

describe('RequestClient — top-level clientRequests', () => {
  it('has get-time', () => {
    expectTypeOf<RequestClient['clientRequests']>().toHaveProperty('get-time');
  });

  it('get-time has correct payload and response', () => {
    expectTypeOf<RequestClient['clientRequests']['get-time']['payload']>().toEqualTypeOf<{}>();
    expectTypeOf<RequestClient['clientRequests']['get-time']['response']>().toEqualTypeOf<{
      now: string;
    }>();
  });

  it('has no-response request', () => {
    expectTypeOf<RequestClient['clientRequests']>().toHaveProperty('no-response');
  });

  it('no-response has an empty payload and a void response (a void acknowledgement)', () => {
    expectTypeOf<RequestClient['clientRequests']['no-response']['payload']>().toEqualTypeOf<{}>();
    expectTypeOf<
      RequestClient['clientRequests']['no-response']['response']
    >().toEqualTypeOf<void>();
  });

  it('has double-response request', () => {
    expectTypeOf<RequestClient['clientRequests']>().toHaveProperty('double-response');
  });

  it('double-response has correct response', () => {
    expectTypeOf<RequestClient['clientRequests']['double-response']['response']>().toEqualTypeOf<{
      count: number;
    }>();
  });

  it('has strict-echo request', () => {
    expectTypeOf<RequestClient['clientRequests']>().toHaveProperty('strict-echo');
  });

  it('strict-echo payload is strict', () => {
    expectTypeOf<RequestClient['clientRequests']['strict-echo']['payload']>().toEqualTypeOf<{
      id: string;
    }>();
  });

  it('strict-echo response is correct', () => {
    expectTypeOf<RequestClient['clientRequests']['strict-echo']['response']>().toEqualTypeOf<{
      echoed: string;
    }>();
  });

  it('has throwing-request', () => {
    expectTypeOf<RequestClient['clientRequests']>().toHaveProperty('throwing-request');
  });

  it('has the declared top-level clientRequests', () => {
    expectTypeOf<keyof RequestClient['clientRequests']>().toEqualTypeOf<
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

  it('room clientRequests has get-channel-info', () => {
    expectTypeOf<RequestClient['channels']['room']['clientRequests']>().toHaveProperty(
      'get-channel-info',
    );
  });

  it('get-channel-info has correct payload and response', () => {
    expectTypeOf<
      RequestClient['channels']['room']['clientRequests']['get-channel-info']['payload']
    >().toEqualTypeOf<{}>();
    expectTypeOf<
      RequestClient['channels']['room']['clientRequests']['get-channel-info']['response']
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
