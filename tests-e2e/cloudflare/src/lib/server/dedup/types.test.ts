import { describe, expectTypeOf, it } from 'vitest';
import type { DedupClient } from './handler.ts';

describe('dedup client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<DedupClient>().toHaveProperty('incoming');
    expectTypeOf<DedupClient>().toHaveProperty('outgoing');
    expectTypeOf<DedupClient>().toHaveProperty('requests');
    expectTypeOf<DedupClient>().toHaveProperty('streams');
    expectTypeOf<DedupClient>().toHaveProperty('namespaces');
    expectTypeOf<DedupClient>().toHaveProperty('channels');
  });
});

describe('DedupClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<DedupClient['incoming']>().not.toBeAny();
    expectTypeOf<DedupClient['outgoing']>().not.toBeAny();
    expectTypeOf<DedupClient['requests']>().not.toBeAny();
    expectTypeOf<DedupClient['streams']>().not.toBeAny();
    expectTypeOf<DedupClient['channels']>().not.toBeAny();
    expectTypeOf<DedupClient['namespaces']>().not.toBeAny();
    expectTypeOf<DedupClient['__errors__']>().not.toBeAny();
  });
});
