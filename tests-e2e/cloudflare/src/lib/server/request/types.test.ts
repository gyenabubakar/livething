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

describe('RequestClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<RequestClient['incoming']>().not.toBeAny();
    expectTypeOf<RequestClient['outgoing']>().not.toBeAny();
    expectTypeOf<RequestClient['requests']>().not.toBeAny();
    expectTypeOf<RequestClient['streams']>().not.toBeAny();
    expectTypeOf<RequestClient['channels']>().not.toBeAny();
    expectTypeOf<RequestClient['namespaces']>().not.toBeAny();
    expectTypeOf<RequestClient['__errors__']>().not.toBeAny();
  });
});
