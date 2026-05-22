import { describe, expectTypeOf, it } from 'vitest';
import type { SequenceClient } from './handler.ts';

describe('SequenceClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<SequenceClient['incoming']>().not.toBeAny();
    expectTypeOf<SequenceClient['outgoing']>().not.toBeAny();
    expectTypeOf<SequenceClient['requests']>().not.toBeAny();
    expectTypeOf<SequenceClient['streams']>().not.toBeAny();
    expectTypeOf<SequenceClient['channels']>().not.toBeAny();
    expectTypeOf<SequenceClient['namespaces']>().not.toBeAny();
    expectTypeOf<SequenceClient['__errors__']>().not.toBeAny();
  });
});

describe('SequenceClient — incoming (server outgoing)', () => {
  it('has tock with empty payload', () => {
    expectTypeOf<SequenceClient['incoming']['tock']>().toEqualTypeOf<{}>();
  });

  it('only tock in incoming', () => {
    expectTypeOf<keyof SequenceClient['incoming']>().toEqualTypeOf<'tock'>();
  });
});

describe('SequenceClient — outgoing (server incoming)', () => {
  it('has tick with empty payload', () => {
    expectTypeOf<SequenceClient['outgoing']['tick']>().toEqualTypeOf<{}>();
  });

  it('only tick in outgoing', () => {
    expectTypeOf<keyof SequenceClient['outgoing']>().toEqualTypeOf<'tick'>();
  });
});

describe('SequenceClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof SequenceClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof SequenceClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof SequenceClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof SequenceClient['namespaces']>().toBeNever();
  });
});

describe('SequenceClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<SequenceClient['__errors__']>().toHaveProperty('validation-failed');
    expectTypeOf<SequenceClient['__errors__']>().toHaveProperty('channel-not-found');
    expectTypeOf<SequenceClient['__errors__']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<SequenceClient['__errors__']>().toHaveProperty('namespace-not-found');
    expectTypeOf<SequenceClient['__errors__']>().toHaveProperty('internal-error');
  });
});
