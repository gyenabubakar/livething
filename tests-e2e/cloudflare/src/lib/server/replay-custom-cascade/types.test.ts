import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayCustomCascadeClient } from './handler.ts';

describe('replay-custom-cascade client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('incoming');
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('requests');
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('streams');
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('channels');
  });
});
