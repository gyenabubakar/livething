import { describe, expectTypeOf, it } from 'vitest';
import type { LifecycleHooksHttpRejectClient } from './handler.ts';

describe('LifecycleHooksHttpRejectClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<LifecycleHooksHttpRejectClient['incoming']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['outgoing']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['requests']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['streams']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['channels']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['namespaces']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['__errors__']>().not.toBeAny();
  });
});

describe('LifecycleHooksHttpRejectClient — all slots are empty (no definitions)', () => {
  it('incoming is empty', () => {
    expectTypeOf<keyof LifecycleHooksHttpRejectClient['incoming']>().toBeNever();
  });

  it('outgoing is empty', () => {
    expectTypeOf<keyof LifecycleHooksHttpRejectClient['outgoing']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof LifecycleHooksHttpRejectClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof LifecycleHooksHttpRejectClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof LifecycleHooksHttpRejectClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof LifecycleHooksHttpRejectClient['namespaces']>().toBeNever();
  });
});

describe('LifecycleHooksHttpRejectClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<LifecycleHooksHttpRejectClient['__errors__']>().toHaveProperty(
      'validation-failed',
    );
    expectTypeOf<LifecycleHooksHttpRejectClient['__errors__']>().toHaveProperty(
      'channel-not-found',
    );
    expectTypeOf<LifecycleHooksHttpRejectClient['__errors__']>().toHaveProperty(
      'channel-not-subscribed',
    );
    expectTypeOf<LifecycleHooksHttpRejectClient['__errors__']>().toHaveProperty(
      'namespace-not-found',
    );
    expectTypeOf<LifecycleHooksHttpRejectClient['__errors__']>().toHaveProperty('internal-error');
  });
});
