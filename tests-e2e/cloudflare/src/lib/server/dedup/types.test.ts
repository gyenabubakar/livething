import { describe, expectTypeOf, it } from 'vitest';
import type { DedupClient } from './handler.ts';

describe('dedup client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<DedupClient>().toHaveProperty('incoming');
    expectTypeOf<DedupClient>().toHaveProperty('outgoing');
    expectTypeOf<DedupClient>().toHaveProperty('requests');
    expectTypeOf<DedupClient>().toHaveProperty('streams');
    expectTypeOf<DedupClient>().toHaveProperty('resumableStreams');
    expectTypeOf<DedupClient>().toHaveProperty('recordedStreams');
    expectTypeOf<DedupClient>().toHaveProperty('namespaces');
    expectTypeOf<DedupClient>().toHaveProperty('channels');
  });
});
