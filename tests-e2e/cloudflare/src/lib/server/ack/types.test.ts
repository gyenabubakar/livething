import { describe, expectTypeOf, it } from 'vitest';
import type { AckClient } from './handler.ts';

describe('ack client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<AckClient>().toHaveProperty('incoming');
    expectTypeOf<AckClient>().toHaveProperty('outgoing');
    expectTypeOf<AckClient>().toHaveProperty('requests');
    expectTypeOf<AckClient>().toHaveProperty('streams');
    expectTypeOf<AckClient>().toHaveProperty('namespaces');
    expectTypeOf<AckClient>().toHaveProperty('channels');
  });
});

describe('AckClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<AckClient['incoming']>().not.toBeAny();
    expectTypeOf<AckClient['outgoing']>().not.toBeAny();
    expectTypeOf<AckClient['requests']>().not.toBeAny();
    expectTypeOf<AckClient['streams']>().not.toBeAny();
    expectTypeOf<AckClient['channels']>().not.toBeAny();
    expectTypeOf<AckClient['namespaces']>().not.toBeAny();
    expectTypeOf<AckClient['__errors__']>().not.toBeAny();
  });
});
