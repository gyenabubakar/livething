import { describe, expectTypeOf, it } from 'vitest';
import type { StreamNudgesClient } from './handler.ts';

describe('stream-nudges client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StreamNudgesClient>().toHaveProperty('incoming');
    expectTypeOf<StreamNudgesClient>().toHaveProperty('outgoing');
    expectTypeOf<StreamNudgesClient>().toHaveProperty('requests');
    expectTypeOf<StreamNudgesClient>().toHaveProperty('streams');
    expectTypeOf<StreamNudgesClient>().toHaveProperty('namespaces');
    expectTypeOf<StreamNudgesClient>().toHaveProperty('channels');
  });
});

describe('StreamNudgesClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<StreamNudgesClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['requests']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['streams']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['channels']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['namespaces']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['__errors__']>().not.toBeAny();
  });
});
