import { describe, expectTypeOf, it } from 'vitest';
import type { StaticVsFamilyIsolationClient } from './handler.ts';

describe('static-vs-family-isolation client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('incoming');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('outgoing');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('requests');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('streams');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('namespaces');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('channels');
  });
});

describe('StaticVsFamilyIsolationClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<StaticVsFamilyIsolationClient['incoming']>().not.toBeAny();
    expectTypeOf<StaticVsFamilyIsolationClient['outgoing']>().not.toBeAny();
    expectTypeOf<StaticVsFamilyIsolationClient['requests']>().not.toBeAny();
    expectTypeOf<StaticVsFamilyIsolationClient['streams']>().not.toBeAny();
    expectTypeOf<StaticVsFamilyIsolationClient['channels']>().not.toBeAny();
    expectTypeOf<StaticVsFamilyIsolationClient['namespaces']>().not.toBeAny();
    expectTypeOf<StaticVsFamilyIsolationClient['__errors__']>().not.toBeAny();
  });
});
