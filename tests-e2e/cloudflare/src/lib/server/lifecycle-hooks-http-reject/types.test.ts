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
