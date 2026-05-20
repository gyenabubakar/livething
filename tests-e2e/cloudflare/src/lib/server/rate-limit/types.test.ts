import { describe, expectTypeOf, it } from 'vitest';
import type { RateLimitClient } from './handler.ts';

describe('rate-limit client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<RateLimitClient>().toHaveProperty('incoming');
    expectTypeOf<RateLimitClient>().toHaveProperty('outgoing');
    expectTypeOf<RateLimitClient>().toHaveProperty('requests');
    expectTypeOf<RateLimitClient>().toHaveProperty('streams');
    expectTypeOf<RateLimitClient>().toHaveProperty('namespaces');
    expectTypeOf<RateLimitClient>().toHaveProperty('channels');
  });
});
