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

describe('GroupFullSurfaceClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<GroupFullSurfaceClient['incoming']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['outgoing']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['requests']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['streams']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['channels']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['namespaces']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['__errors__']>().not.toBeAny();
  });
});
