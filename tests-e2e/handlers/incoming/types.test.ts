import { describe, expectTypeOf, it } from 'vitest';
import type { IncomingClient } from './handler.ts';

describe('IncomingClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<IncomingClient['incoming']>().not.toBeAny();
    expectTypeOf<IncomingClient['outgoing']>().not.toBeAny();
    expectTypeOf<IncomingClient['clientRequests']>().not.toBeAny();
    expectTypeOf<IncomingClient['streams']>().not.toBeAny();
    expectTypeOf<IncomingClient['channels']>().not.toBeAny();

    expectTypeOf<IncomingClient['errors']>().not.toBeAny();
  });
});

describe('IncomingClient — incoming (server outgoing)', () => {
  it('has echo-pong', () => {
    expectTypeOf<IncomingClient['incoming']['echo-pong']>().toEqualTypeOf<{ text: string }>();
  });

  it('has async-done', () => {
    expectTypeOf<IncomingClient['incoming']['async-done']>().toEqualTypeOf<{ message: string }>();
  });

  it('has validation-error-fired', () => {
    expectTypeOf<IncomingClient['incoming']['validation-error-fired']>().toEqualTypeOf<{
      event: string;
    }>();
  });

  it('has the declared incoming events', () => {
    expectTypeOf<keyof IncomingClient['incoming']>().toEqualTypeOf<
      'echo-pong' | 'async-done' | 'validation-error-fired' | 'anything-echo'
    >();
  });
});

describe('IncomingClient — outgoing (server incoming)', () => {
  it('has echo-ping', () => {
    expectTypeOf<IncomingClient['outgoing']['echo-ping']>().toEqualTypeOf<{ text: string }>();
  });

  it('has async-ping', () => {
    expectTypeOf<IncomingClient['outgoing']['async-ping']>().toEqualTypeOf<{ delay: number }>();
  });

  it('has the declared outgoing events', () => {
    expectTypeOf<keyof IncomingClient['outgoing']>().toEqualTypeOf<
      | 'echo-ping'
      | 'async-ping'
      | 'echo-anything'
      | 'trigger-send-undeclared'
      | 'trigger-send-bad-payload'
    >();
  });
});

describe('IncomingClient — empty slots', () => {
  it('clientRequests is empty', () => {
    expectTypeOf<keyof IncomingClient['clientRequests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof IncomingClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof IncomingClient['channels']>().toBeNever();
  });
});

describe('IncomingClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<IncomingClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<IncomingClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<IncomingClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<IncomingClient['errors']>().toHaveProperty('internal-error');
  });
});
