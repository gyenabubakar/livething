import { describe, expectTypeOf, it } from 'vitest';
import type { AckClient } from './handler.ts';

describe('AckClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<AckClient['incoming']>().not.toBeAny();
    expectTypeOf<AckClient['outgoing']>().not.toBeAny();
    expectTypeOf<AckClient['requests']>().not.toBeAny();
    expectTypeOf<AckClient['streams']>().not.toBeAny();
    expectTypeOf<AckClient['channels']>().not.toBeAny();
    expectTypeOf<AckClient['namespaces']>().not.toBeAny();
    expectTypeOf<AckClient['errors']>().not.toBeAny();
  });
});

describe('AckClient — incoming (server outgoing → client receives)', () => {
  it('has ack-check-ok with empty payload', () => {
    expectTypeOf<AckClient['incoming']['ack-check-ok']>().toEqualTypeOf<{}>();
  });

  it('no extra keys in incoming', () => {
    expectTypeOf<keyof AckClient['incoming']>().toEqualTypeOf<'ack-check-ok'>();
  });
});

describe('AckClient — outgoing (server incoming → client sends)', () => {
  it('has ack-check with empty payload', () => {
    expectTypeOf<AckClient['outgoing']['ack-check']>().toEqualTypeOf<{}>();
  });

  it('has throw-me with empty payload', () => {
    expectTypeOf<AckClient['outgoing']['throw-me']>().toEqualTypeOf<{}>();
  });

  it('only ack-check and throw-me in outgoing', () => {
    expectTypeOf<keyof AckClient['outgoing']>().toEqualTypeOf<'ack-check' | 'throw-me'>();
  });
});

describe('AckClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof AckClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof AckClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof AckClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof AckClient['namespaces']>().toBeNever();
  });
});

describe('AckClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<AckClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<AckClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<AckClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<AckClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<AckClient['errors']>().toHaveProperty('internal-error');
  });
});
