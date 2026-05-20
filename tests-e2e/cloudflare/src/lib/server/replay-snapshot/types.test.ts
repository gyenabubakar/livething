import { describe, expectTypeOf, it } from 'vitest';
import type { ReplaySnapshotClient } from './handler.ts';

describe('replay-snapshot client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('incoming');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('requests');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('streams');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('resumableStreams');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('recordedStreams');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplaySnapshotClient>().toHaveProperty('channels');
  });
});
