import { describe, expectTypeOf, it } from 'vitest';
import type { ReplaySnapshotClient } from './handler.ts';

describe('replay-snapshot client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('incoming');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('requests');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('streams');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('channels');
  });
});

describe('ReplaySnapshotClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ReplaySnapshotClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplaySnapshotClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplaySnapshotClient['requests']>().not.toBeAny();
    expectTypeOf<ReplaySnapshotClient['streams']>().not.toBeAny();
    expectTypeOf<ReplaySnapshotClient['channels']>().not.toBeAny();
    expectTypeOf<ReplaySnapshotClient['namespaces']>().not.toBeAny();
    expectTypeOf<ReplaySnapshotClient['__errors__']>().not.toBeAny();
  });
});
