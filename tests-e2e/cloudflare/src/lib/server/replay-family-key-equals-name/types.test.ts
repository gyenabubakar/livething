import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayFamilyKeyEqualsNameClient } from './handler.ts';

describe('replay-family-key-equals-name client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('incoming');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('requests');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('streams');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('channels');
  });
});

describe('ReplayFamilyKeyEqualsNameClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['requests']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['streams']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['channels']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['namespaces']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['__errors__']>().not.toBeAny();
  });
});
