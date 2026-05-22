import { describe, expectTypeOf, it } from 'vitest';
import type { StreamBasicClient } from './handler.ts';

describe('stream-basic client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StreamBasicClient>().toHaveProperty('incoming');
    expectTypeOf<StreamBasicClient>().toHaveProperty('outgoing');
    expectTypeOf<StreamBasicClient>().toHaveProperty('requests');
    expectTypeOf<StreamBasicClient>().toHaveProperty('streams');
    expectTypeOf<StreamBasicClient>().toHaveProperty('namespaces');
    expectTypeOf<StreamBasicClient>().toHaveProperty('channels');
  });
});

describe('StreamBasicClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<StreamBasicClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['requests']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['streams']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['channels']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['namespaces']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['__errors__']>().not.toBeAny();
  });
});
