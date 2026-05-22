import { describe, expectTypeOf, it } from 'vitest';
import type { ErrorsFactoryClient } from './handler.ts';

describe('ErrorsFactoryClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ErrorsFactoryClient['incoming']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['outgoing']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['requests']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['streams']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['channels']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['namespaces']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['__errors__']>().not.toBeAny();
  });
});

describe('ErrorsFactoryClient — outgoing (server incoming)', () => {
  it('has trigger-not-found with empty payload', () => {
    expectTypeOf<ErrorsFactoryClient['outgoing']['trigger-not-found']>().toEqualTypeOf<{}>();
  });

  it('has trigger-forbidden with empty payload', () => {
    expectTypeOf<ErrorsFactoryClient['outgoing']['trigger-forbidden']>().toEqualTypeOf<{}>();
  });

  it('has trigger-simple with empty payload', () => {
    expectTypeOf<ErrorsFactoryClient['outgoing']['trigger-simple']>().toEqualTypeOf<{}>();
  });

  it('has trigger-unregistered with empty payload', () => {
    expectTypeOf<ErrorsFactoryClient['outgoing']['trigger-unregistered']>().toEqualTypeOf<{}>();
  });

  it('has trigger-bigint with empty payload', () => {
    expectTypeOf<ErrorsFactoryClient['outgoing']['trigger-bigint']>().toEqualTypeOf<{}>();
  });

  it('exactly five events in outgoing', () => {
    expectTypeOf<keyof ErrorsFactoryClient['outgoing']>().toEqualTypeOf<
      | 'trigger-not-found'
      | 'trigger-forbidden'
      | 'trigger-simple'
      | 'trigger-unregistered'
      | 'trigger-bigint'
    >();
  });
});

describe('ErrorsFactoryClient — declared errors', () => {
  it('has not-found error with id detail', () => {
    expectTypeOf<ErrorsFactoryClient['__errors__']['not-found']>().toEqualTypeOf<{ id: string }>();
  });

  it('has forbidden error with reason detail', () => {
    expectTypeOf<ErrorsFactoryClient['__errors__']['forbidden']>().toEqualTypeOf<{
      reason: string;
    }>();
  });

  it('has simple-error (no detail schema)', () => {
    expectTypeOf<ErrorsFactoryClient['__errors__']>().toHaveProperty('simple-error');
  });

  it('has bigint-detail error', () => {
    expectTypeOf<ErrorsFactoryClient['__errors__']>().toHaveProperty('bigint-detail');
  });
});

describe('ErrorsFactoryClient — builtin errors present', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ErrorsFactoryClient['__errors__']>().toHaveProperty('validation-failed');
    expectTypeOf<ErrorsFactoryClient['__errors__']>().toHaveProperty('channel-not-found');
    expectTypeOf<ErrorsFactoryClient['__errors__']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ErrorsFactoryClient['__errors__']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ErrorsFactoryClient['__errors__']>().toHaveProperty('internal-error');
  });
});

describe('ErrorsFactoryClient — empty slots', () => {
  it('incoming is empty', () => {
    expectTypeOf<keyof ErrorsFactoryClient['incoming']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof ErrorsFactoryClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ErrorsFactoryClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof ErrorsFactoryClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof ErrorsFactoryClient['namespaces']>().toBeNever();
  });
});
