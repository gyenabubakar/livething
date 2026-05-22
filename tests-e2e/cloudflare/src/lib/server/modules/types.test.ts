import { describe, expectTypeOf, it } from 'vitest';
import type { ModulesClient } from './handler.ts';

describe('modules client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ModulesClient>().toHaveProperty('incoming');
    expectTypeOf<ModulesClient>().toHaveProperty('outgoing');
    expectTypeOf<ModulesClient>().toHaveProperty('requests');
    expectTypeOf<ModulesClient>().toHaveProperty('streams');
    expectTypeOf<ModulesClient>().toHaveProperty('namespaces');
    expectTypeOf<ModulesClient>().toHaveProperty('channels');
  });
});

describe('ModulesClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ModulesClient['incoming']>().not.toBeAny();
    expectTypeOf<ModulesClient['outgoing']>().not.toBeAny();
    expectTypeOf<ModulesClient['requests']>().not.toBeAny();
    expectTypeOf<ModulesClient['streams']>().not.toBeAny();
    expectTypeOf<ModulesClient['channels']>().not.toBeAny();
    expectTypeOf<ModulesClient['namespaces']>().not.toBeAny();
    expectTypeOf<ModulesClient['__errors__']>().not.toBeAny();
  });
});
