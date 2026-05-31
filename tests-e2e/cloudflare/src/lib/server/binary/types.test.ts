import { describe, expectTypeOf, it } from 'vitest';
import type { BinaryClient } from './handler.ts';

describe('BinaryClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<BinaryClient['incoming']>().not.toBeAny();
    expectTypeOf<BinaryClient['outgoing']>().not.toBeAny();
    expectTypeOf<BinaryClient['requests']>().not.toBeAny();
    expectTypeOf<BinaryClient['streams']>().not.toBeAny();
    expectTypeOf<BinaryClient['channels']>().not.toBeAny();
    expectTypeOf<BinaryClient['namespaces']>().not.toBeAny();
    expectTypeOf<BinaryClient['errors']>().not.toBeAny();
  });
});

describe('BinaryClient — incoming (server outgoing)', () => {
  it('has binary-meta with correct shape', () => {
    expectTypeOf<BinaryClient['incoming']['binary-meta']>().toEqualTypeOf<{
      size: number;
      username: string;
    }>();
  });

  it('has binary-hook-error-observed with correct shape', () => {
    expectTypeOf<BinaryClient['incoming']['binary-hook-error-observed']>().toEqualTypeOf<{
      message: string;
    }>();
  });

  it('only these two events in incoming', () => {
    expectTypeOf<keyof BinaryClient['incoming']>().toEqualTypeOf<
      'binary-meta' | 'binary-hook-error-observed'
    >();
  });
});

describe('BinaryClient — outgoing (server incoming)', () => {
  it('has broadcast-all with correct shape', () => {
    expectTypeOf<BinaryClient['outgoing']['broadcast-all']>().toEqualTypeOf<{ size: number }>();
  });

  it('has broadcast-exclude-self with correct shape', () => {
    expectTypeOf<BinaryClient['outgoing']['broadcast-exclude-self']>().toEqualTypeOf<{
      size: number;
    }>();
  });

  it('has send-self-binary with correct shape', () => {
    expectTypeOf<BinaryClient['outgoing']['send-self-binary']>().toEqualTypeOf<{ size: number }>();
  });

  it('exactly three events in outgoing', () => {
    expectTypeOf<keyof BinaryClient['outgoing']>().toEqualTypeOf<
      'broadcast-all' | 'broadcast-exclude-self' | 'send-self-binary'
    >();
  });
});

describe('BinaryClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof BinaryClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof BinaryClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof BinaryClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof BinaryClient['namespaces']>().toBeNever();
  });
});

describe('BinaryClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<BinaryClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<BinaryClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<BinaryClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<BinaryClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<BinaryClient['errors']>().toHaveProperty('internal-error');
  });
});
