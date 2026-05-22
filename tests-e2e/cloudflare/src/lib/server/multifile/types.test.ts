import { describe, expectTypeOf, it } from 'vitest';
import type { MultifileClient } from './handler.ts';

describe('multifile client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<MultifileClient>().toHaveProperty('incoming');
    expectTypeOf<MultifileClient>().toHaveProperty('outgoing');
    expectTypeOf<MultifileClient>().toHaveProperty('requests');
    expectTypeOf<MultifileClient>().toHaveProperty('streams');
    expectTypeOf<MultifileClient>().toHaveProperty('namespaces');
    expectTypeOf<MultifileClient>().toHaveProperty('channels');
  });
});

describe('MultifileClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<MultifileClient['incoming']>().not.toBeAny();
    expectTypeOf<MultifileClient['outgoing']>().not.toBeAny();
    expectTypeOf<MultifileClient['requests']>().not.toBeAny();
    expectTypeOf<MultifileClient['streams']>().not.toBeAny();
    expectTypeOf<MultifileClient['channels']>().not.toBeAny();
    expectTypeOf<MultifileClient['namespaces']>().not.toBeAny();
    expectTypeOf<MultifileClient['__errors__']>().not.toBeAny();
  });
});
