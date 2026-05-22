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

describe('InterceptClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<InterceptClient['incoming']>().not.toBeAny();
    expectTypeOf<InterceptClient['outgoing']>().not.toBeAny();
    expectTypeOf<InterceptClient['requests']>().not.toBeAny();
    expectTypeOf<InterceptClient['streams']>().not.toBeAny();
    expectTypeOf<InterceptClient['channels']>().not.toBeAny();
    expectTypeOf<InterceptClient['namespaces']>().not.toBeAny();
    expectTypeOf<InterceptClient['__errors__']>().not.toBeAny();
  });
});
