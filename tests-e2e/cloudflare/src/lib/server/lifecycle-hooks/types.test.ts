import { describe, expectTypeOf, it } from 'vitest';
import type { LifecycleHooksClient } from './handler.ts';

describe('lifecycle-hooks client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('incoming');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('outgoing');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('requests');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('streams');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('resumableStreams');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('recordedStreams');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('namespaces');
    expectTypeOf<LifecycleHooksClient>().toHaveProperty('channels');
  });
});
