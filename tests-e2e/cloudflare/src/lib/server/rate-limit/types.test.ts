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

describe('RateLimitClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<RateLimitClient['incoming']>().not.toBeAny();
    expectTypeOf<RateLimitClient['outgoing']>().not.toBeAny();
    expectTypeOf<RateLimitClient['requests']>().not.toBeAny();
    expectTypeOf<RateLimitClient['streams']>().not.toBeAny();
    expectTypeOf<RateLimitClient['channels']>().not.toBeAny();
    expectTypeOf<RateLimitClient['namespaces']>().not.toBeAny();
    expectTypeOf<RateLimitClient['__errors__']>().not.toBeAny();
  });
});
