import { describe, expectTypeOf, it } from 'vitest';
import type { SequenceClient } from './handler.ts';

describe('sequence client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<SequenceClient>().toHaveProperty('incoming');
    expectTypeOf<SequenceClient>().toHaveProperty('outgoing');
    expectTypeOf<SequenceClient>().toHaveProperty('requests');
    expectTypeOf<SequenceClient>().toHaveProperty('streams');
    expectTypeOf<SequenceClient>().toHaveProperty('namespaces');
    expectTypeOf<SequenceClient>().toHaveProperty('channels');
  });
});

describe('SequenceClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<SequenceClient['incoming']>().not.toBeAny();
    expectTypeOf<SequenceClient['outgoing']>().not.toBeAny();
    expectTypeOf<SequenceClient['requests']>().not.toBeAny();
    expectTypeOf<SequenceClient['streams']>().not.toBeAny();
    expectTypeOf<SequenceClient['channels']>().not.toBeAny();
    expectTypeOf<SequenceClient['namespaces']>().not.toBeAny();
    expectTypeOf<SequenceClient['__errors__']>().not.toBeAny();
  });
});
