import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayCustomCascadeClient } from './handler.ts';

describe('replay-custom-cascade client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('incoming');
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('requests');
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('streams');
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplayCustomCascadeClient>().toHaveProperty('channels');
  });
});

describe('ReplayCustomCascadeClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ReplayCustomCascadeClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['requests']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['streams']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['channels']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['namespaces']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['__errors__']>().not.toBeAny();
  });
});
