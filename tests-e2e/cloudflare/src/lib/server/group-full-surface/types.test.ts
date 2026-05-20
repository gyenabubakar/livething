import { describe, expectTypeOf, it } from 'vitest';
import type { GroupFullSurfaceClient } from './handler.ts';

describe('group-full-surface client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<GroupFullSurfaceClient>().toHaveProperty('incoming');
    expectTypeOf<GroupFullSurfaceClient>().toHaveProperty('outgoing');
    expectTypeOf<GroupFullSurfaceClient>().toHaveProperty('requests');
    expectTypeOf<GroupFullSurfaceClient>().toHaveProperty('streams');
    expectTypeOf<GroupFullSurfaceClient>().toHaveProperty('namespaces');
    expectTypeOf<GroupFullSurfaceClient>().toHaveProperty('channels');
  });
});
