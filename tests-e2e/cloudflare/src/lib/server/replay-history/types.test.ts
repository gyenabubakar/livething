import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayClient } from './handler.ts';

describe('replay-history client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplayClient>().toHaveProperty('incoming');
    expectTypeOf<ReplayClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplayClient>().toHaveProperty('requests');
    expectTypeOf<ReplayClient>().toHaveProperty('streams');
    expectTypeOf<ReplayClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplayClient>().toHaveProperty('channels');
  });
});
