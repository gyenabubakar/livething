import { describe, expectTypeOf, it } from 'vitest';
import type { PersistenceClient } from './handler.ts';

describe('persistence client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<PersistenceClient>().toHaveProperty('incoming');
    expectTypeOf<PersistenceClient>().toHaveProperty('outgoing');
    expectTypeOf<PersistenceClient>().toHaveProperty('requests');
    expectTypeOf<PersistenceClient>().toHaveProperty('streams');
    expectTypeOf<PersistenceClient>().toHaveProperty('namespaces');
    expectTypeOf<PersistenceClient>().toHaveProperty('channels');
  });
});

describe('PersistenceClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<PersistenceClient['incoming']>().not.toBeAny();
    expectTypeOf<PersistenceClient['outgoing']>().not.toBeAny();
    expectTypeOf<PersistenceClient['requests']>().not.toBeAny();
    expectTypeOf<PersistenceClient['streams']>().not.toBeAny();
    expectTypeOf<PersistenceClient['channels']>().not.toBeAny();
    expectTypeOf<PersistenceClient['namespaces']>().not.toBeAny();
    expectTypeOf<PersistenceClient['__errors__']>().not.toBeAny();
  });
});
