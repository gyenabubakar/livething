import { describe, expectTypeOf, it } from 'vitest';
import type { IncomingClient } from './handler.ts';

describe('incoming client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<IncomingClient>().toHaveProperty('incoming');
    expectTypeOf<IncomingClient>().toHaveProperty('outgoing');
    expectTypeOf<IncomingClient>().toHaveProperty('requests');
    expectTypeOf<IncomingClient>().toHaveProperty('streams');
    expectTypeOf<IncomingClient>().toHaveProperty('namespaces');
    expectTypeOf<IncomingClient>().toHaveProperty('channels');
  });
});

describe('IncomingClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<IncomingClient['incoming']>().not.toBeAny();
    expectTypeOf<IncomingClient['outgoing']>().not.toBeAny();
    expectTypeOf<IncomingClient['requests']>().not.toBeAny();
    expectTypeOf<IncomingClient['streams']>().not.toBeAny();
    expectTypeOf<IncomingClient['channels']>().not.toBeAny();
    expectTypeOf<IncomingClient['namespaces']>().not.toBeAny();
    expectTypeOf<IncomingClient['__errors__']>().not.toBeAny();
  });
});
