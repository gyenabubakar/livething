import { describe, expectTypeOf, it } from 'vitest';
import type { IncomingClient } from './handler.ts';

describe('IncomingClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<IncomingClient['incoming']>().not.toBeAny();
    expectTypeOf<IncomingClient['outgoing']>().not.toBeAny();
    expectTypeOf<IncomingClient['requests']>().not.toBeAny();
    expectTypeOf<IncomingClient['streams']>().not.toBeAny();
    expectTypeOf<IncomingClient['channels']>().not.toBeAny();
    expectTypeOf<IncomingClient['namespaces']>().not.toBeAny();
    expectTypeOf<IncomingClient['__errors__']>().not.toBeAny();
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

  it('exactly three events in incoming', () => {
    expectTypeOf<keyof IncomingClient['incoming']>().toEqualTypeOf<
      'echo-pong' | 'async-done' | 'validation-error-fired'
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

  it('exactly two events in outgoing', () => {
    expectTypeOf<keyof IncomingClient['outgoing']>().toEqualTypeOf<'echo-ping' | 'async-ping'>();
  });
});

describe('IncomingClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof IncomingClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof IncomingClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof IncomingClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof IncomingClient['namespaces']>().toBeNever();
  });
});

describe('IncomingClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<IncomingClient['__errors__']>().toHaveProperty('validation-failed');
    expectTypeOf<IncomingClient['__errors__']>().toHaveProperty('channel-not-found');
    expectTypeOf<IncomingClient['__errors__']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<IncomingClient['__errors__']>().toHaveProperty('namespace-not-found');
    expectTypeOf<IncomingClient['__errors__']>().toHaveProperty('internal-error');
  });
});
