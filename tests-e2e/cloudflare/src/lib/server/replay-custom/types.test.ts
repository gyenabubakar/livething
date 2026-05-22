import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayCustomClient } from './handler.ts';

describe('replay-custom client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplayCustomClient>().toHaveProperty('incoming');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('requests');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('streams');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('channels');
  });
});

describe('ReplayCustomClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ReplayCustomClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['requests']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['streams']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['channels']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['namespaces']>().not.toBeAny();
    expectTypeOf<ReplayCustomClient['__errors__']>().not.toBeAny();
  });
});
