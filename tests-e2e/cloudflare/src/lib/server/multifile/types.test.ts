import { describe, expectTypeOf, it } from 'vitest';
import type { MultifileClient } from './handler.ts';

describe('multifile client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<MultifileClient>().toHaveProperty('incoming');
    expectTypeOf<MultifileClient>().toHaveProperty('outgoing');
    expectTypeOf<MultifileClient>().toHaveProperty('requests');
    expectTypeOf<MultifileClient>().toHaveProperty('streams');
    expectTypeOf<MultifileClient>().toHaveProperty('resumableStreams');
    expectTypeOf<MultifileClient>().toHaveProperty('recordedStreams');
    expectTypeOf<MultifileClient>().toHaveProperty('namespaces');
    expectTypeOf<MultifileClient>().toHaveProperty('channels');
  });
});
