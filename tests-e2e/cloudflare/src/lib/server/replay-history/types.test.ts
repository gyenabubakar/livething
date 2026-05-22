import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayClient } from './handler.ts';

describe('replay-history client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplayClient>().toHaveProperty('incoming');
    expectTypeOf<ReplayClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplayClient>().toHaveProperty('requests');
    expectTypeOf<ReplayClient>().toHaveProperty('streams');
    expectTypeOf<ReplayClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplayClient>().toHaveProperty('channels');
  });
});

describe('ReplayClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ReplayClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplayClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplayClient['requests']>().not.toBeAny();
    expectTypeOf<ReplayClient['streams']>().not.toBeAny();
    expectTypeOf<ReplayClient['channels']>().not.toBeAny();
    expectTypeOf<ReplayClient['namespaces']>().not.toBeAny();
    expectTypeOf<ReplayClient['__errors__']>().not.toBeAny();
  });
});
