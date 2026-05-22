import { describe, expectTypeOf, it } from 'vitest';
import type { LifecycleHooksClient } from './handler.ts';

describe('lifecycle-hooks client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('incoming');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('outgoing');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('requests');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('streams');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('namespaces');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('channels');
  });
});

describe('LifecycleHooksClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<LifecycleHooksClient['incoming']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['outgoing']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['requests']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['streams']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['channels']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['namespaces']>().not.toBeAny();
    expectTypeOf<LifecycleHooksClient['__errors__']>().not.toBeAny();
  });
});
