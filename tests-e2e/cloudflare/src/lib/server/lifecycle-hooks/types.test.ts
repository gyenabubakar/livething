import { describe, expectTypeOf, it } from 'vitest';
import type { LifecycleHooksClient } from './handler.ts';

describe('LifecycleHooksClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<LifecycleHooksClient['incoming']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['outgoing']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['requests']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['streams']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['channels']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['namespaces']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['errors']>().not.toBeAny();
  });
});

describe('LifecycleHooksClient — incoming (server outgoing)', () => {
  it('has connected', () => {
    expectTypeOf<LifecycleHooksClient['incoming']['connected']>().toEqualTypeOf<{
      username: string;
    }>();
  });

  it('has disconnected', () => {
    expectTypeOf<LifecycleHooksClient['incoming']['disconnected']>().toEqualTypeOf<{
      username: string;
    }>();
  });

  it('has disconnect-close', () => {
    expectTypeOf<LifecycleHooksClient['incoming']['disconnect-close']>().toEqualTypeOf<{
      username: string;
      code: number;
      reason: string;
    }>();
  });

  it('has validation-error-fired', () => {
    expectTypeOf<LifecycleHooksClient['incoming']['validation-error-fired']>().toEqualTypeOf<{
      event: string;
    }>();
  });

  it('has error-fired', () => {
    expectTypeOf<LifecycleHooksClient['incoming']['error-fired']>().toEqualTypeOf<{
      message: string;
    }>();
  });

  it('has upgrade-meta', () => {
    expectTypeOf<LifecycleHooksClient['incoming']['upgrade-meta']>().toEqualTypeOf<{
      username: string;
    }>();
  });

  it('has connect-count', () => {
    expectTypeOf<LifecycleHooksClient['incoming']['connect-count']>().toEqualTypeOf<{
      count: number;
    }>();
  });

  it('has async-hook-complete', () => {
    expectTypeOf<LifecycleHooksClient['incoming']['async-hook-complete']>().toEqualTypeOf<{
      complete: boolean;
    }>();
  });

  it('exactly eight events in incoming', () => {
    expectTypeOf<keyof LifecycleHooksClient['incoming']>().toEqualTypeOf<
      | 'connected'
      | 'disconnected'
      | 'disconnect-close'
      | 'validation-error-fired'
      | 'error-fired'
      | 'upgrade-meta'
      | 'connect-count'
      | 'async-hook-complete'
    >();
  });
});

describe('LifecycleHooksClient — outgoing (server incoming)', () => {
  it('has bad-event', () => {
    expectTypeOf<LifecycleHooksClient['outgoing']['bad-event']>().toEqualTypeOf<{
      value: number;
    }>();
  });

  it('has trigger-error with empty payload', () => {
    expectTypeOf<LifecycleHooksClient['outgoing']['trigger-error']>().toEqualTypeOf<{}>();
  });

  it('exactly two events in outgoing', () => {
    expectTypeOf<keyof LifecycleHooksClient['outgoing']>().toEqualTypeOf<
      'bad-event' | 'trigger-error'
    >();
  });
});

describe('LifecycleHooksClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof LifecycleHooksClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof LifecycleHooksClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof LifecycleHooksClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof LifecycleHooksClient['namespaces']>().toBeNever();
  });
});

describe('LifecycleHooksClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<LifecycleHooksClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<LifecycleHooksClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<LifecycleHooksClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<LifecycleHooksClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<LifecycleHooksClient['errors']>().toHaveProperty('internal-error');
  });
});
