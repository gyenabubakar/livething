import { describe, expectTypeOf, it } from 'vitest';
import type { HibernationClient } from './handler.ts';

describe('hibernation client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<HibernationClient>().toHaveProperty('incoming');
    expectTypeOf<HibernationClient>().toHaveProperty('outgoing');
    expectTypeOf<HibernationClient>().toHaveProperty('requests');
    expectTypeOf<HibernationClient>().toHaveProperty('streams');
    expectTypeOf<HibernationClient>().toHaveProperty('resumableStreams');
    expectTypeOf<HibernationClient>().toHaveProperty('recordedStreams');
    expectTypeOf<HibernationClient>().toHaveProperty('namespaces');
    expectTypeOf<HibernationClient>().toHaveProperty('channels');
  });
});
