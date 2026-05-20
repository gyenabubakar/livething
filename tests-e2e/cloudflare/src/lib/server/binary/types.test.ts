import { describe, expectTypeOf, it } from 'vitest';
import type { BinaryClient } from './handler.ts';

describe('binary client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<BinaryClient>().toHaveProperty('incoming');
    expectTypeOf<BinaryClient>().toHaveProperty('outgoing');
    expectTypeOf<BinaryClient>().toHaveProperty('requests');
    expectTypeOf<BinaryClient>().toHaveProperty('streams');
    expectTypeOf<BinaryClient>().toHaveProperty('namespaces');
    expectTypeOf<BinaryClient>().toHaveProperty('channels');
  });
});
