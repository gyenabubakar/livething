import { describe, expectTypeOf, it } from 'vitest';
import type { InterceptClient } from './handler.ts';

describe('intercept client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<InterceptClient>().toHaveProperty('incoming');
    expectTypeOf<InterceptClient>().toHaveProperty('outgoing');
    expectTypeOf<InterceptClient>().toHaveProperty('requests');
    expectTypeOf<InterceptClient>().toHaveProperty('streams');
    expectTypeOf<InterceptClient>().toHaveProperty('namespaces');
    expectTypeOf<InterceptClient>().toHaveProperty('channels');
  });
});
