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

describe('BinaryClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<BinaryClient['incoming']>().not.toBeAny();
    expectTypeOf<BinaryClient['outgoing']>().not.toBeAny();
    expectTypeOf<BinaryClient['requests']>().not.toBeAny();
    expectTypeOf<BinaryClient['streams']>().not.toBeAny();
    expectTypeOf<BinaryClient['channels']>().not.toBeAny();
    expectTypeOf<BinaryClient['namespaces']>().not.toBeAny();
    expectTypeOf<BinaryClient['__errors__']>().not.toBeAny();
  });
});
