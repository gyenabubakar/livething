import { describe, expectTypeOf, it } from 'vitest';
import type { SequenceClient } from './handler.ts';

describe('sequence client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<SequenceClient>().toHaveProperty('incoming');
    expectTypeOf<SequenceClient>().toHaveProperty('outgoing');
    expectTypeOf<SequenceClient>().toHaveProperty('requests');
    expectTypeOf<SequenceClient>().toHaveProperty('streams');
    expectTypeOf<SequenceClient>().toHaveProperty('resumableStreams');
    expectTypeOf<SequenceClient>().toHaveProperty('recordedStreams');
    expectTypeOf<SequenceClient>().toHaveProperty('namespaces');
    expectTypeOf<SequenceClient>().toHaveProperty('channels');
  });
});
