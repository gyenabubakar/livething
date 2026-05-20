import { describe, expectTypeOf, it } from 'vitest';
import type { RequestClient } from './handler.ts';

describe('request client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<RequestClient>().toHaveProperty('incoming');
    expectTypeOf<RequestClient>().toHaveProperty('outgoing');
    expectTypeOf<RequestClient>().toHaveProperty('requests');
    expectTypeOf<RequestClient>().toHaveProperty('streams');
    expectTypeOf<RequestClient>().toHaveProperty('namespaces');
    expectTypeOf<RequestClient>().toHaveProperty('channels');
  });
});
