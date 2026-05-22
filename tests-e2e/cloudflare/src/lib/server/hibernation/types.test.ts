import { describe, expectTypeOf, it } from 'vitest';
import type { HibernationClient } from './handler.ts';

describe('hibernation client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<HibernationClient>().toHaveProperty('incoming');
    expectTypeOf<HibernationClient>().toHaveProperty('outgoing');
    expectTypeOf<HibernationClient>().toHaveProperty('requests');
    expectTypeOf<HibernationClient>().toHaveProperty('streams');
    expectTypeOf<HibernationClient>().toHaveProperty('namespaces');
    expectTypeOf<HibernationClient>().toHaveProperty('channels');
  });
});

describe('HibernationClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<HibernationClient['incoming']>().not.toBeAny();
    expectTypeOf<HibernationClient['outgoing']>().not.toBeAny();
    expectTypeOf<HibernationClient['requests']>().not.toBeAny();
    expectTypeOf<HibernationClient['streams']>().not.toBeAny();
    expectTypeOf<HibernationClient['channels']>().not.toBeAny();
    expectTypeOf<HibernationClient['namespaces']>().not.toBeAny();
    expectTypeOf<HibernationClient['__errors__']>().not.toBeAny();
  });
});
