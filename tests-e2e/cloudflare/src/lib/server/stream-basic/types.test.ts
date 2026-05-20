import { describe, expectTypeOf, it } from 'vitest';
import type { StreamBasicClient } from './handler.ts';

describe('stream-basic client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StreamBasicClient>().toHaveProperty('incoming');
    expectTypeOf<StreamBasicClient>().toHaveProperty('outgoing');
    expectTypeOf<StreamBasicClient>().toHaveProperty('requests');
    expectTypeOf<StreamBasicClient>().toHaveProperty('streams');
    expectTypeOf<StreamBasicClient>().toHaveProperty('resumableStreams');
    expectTypeOf<StreamBasicClient>().toHaveProperty('recordedStreams');
    expectTypeOf<StreamBasicClient>().toHaveProperty('namespaces');
    expectTypeOf<StreamBasicClient>().toHaveProperty('channels');
  });
});
