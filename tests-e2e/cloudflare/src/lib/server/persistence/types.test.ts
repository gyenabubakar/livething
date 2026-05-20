import { describe, expectTypeOf, it } from 'vitest';
import type { PersistenceClient } from './handler.ts';

describe('persistence client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<PersistenceClient>().toHaveProperty('incoming');
    expectTypeOf<PersistenceClient>().toHaveProperty('outgoing');
    expectTypeOf<PersistenceClient>().toHaveProperty('requests');
    expectTypeOf<PersistenceClient>().toHaveProperty('streams');
    expectTypeOf<PersistenceClient>().toHaveProperty('resumableStreams');
    expectTypeOf<PersistenceClient>().toHaveProperty('recordedStreams');
    expectTypeOf<PersistenceClient>().toHaveProperty('namespaces');
    expectTypeOf<PersistenceClient>().toHaveProperty('channels');
  });
});
