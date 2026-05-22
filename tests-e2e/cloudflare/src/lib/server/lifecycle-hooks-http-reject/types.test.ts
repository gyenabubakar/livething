import { describe, expectTypeOf, it } from 'vitest';
import type { LifecycleHooksHttpRejectClient } from './handler.ts';

describe('lifecycle-hooks-http-reject client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<LifecycleHooksHttpRejectClient>().toHaveProperty('incoming');
    expectTypeOf<LifecycleHooksHttpRejectClient>().toHaveProperty('outgoing');
    expectTypeOf<LifecycleHooksHttpRejectClient>().toHaveProperty('requests');
    expectTypeOf<LifecycleHooksHttpRejectClient>().toHaveProperty('streams');
    expectTypeOf<LifecycleHooksHttpRejectClient>().toHaveProperty('namespaces');
    expectTypeOf<LifecycleHooksHttpRejectClient>().toHaveProperty('channels');
  });
});

describe('LifecycleHooksHttpRejectClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<LifecycleHooksHttpRejectClient['incoming']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['outgoing']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['requests']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['streams']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['channels']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['namespaces']>().not.toBeAny();
    expectTypeOf<LifecycleHooksHttpRejectClient['__errors__']>().not.toBeAny();
  });
});
