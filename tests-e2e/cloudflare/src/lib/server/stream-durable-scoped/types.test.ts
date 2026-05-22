import { describe, expectTypeOf, it } from 'vitest';
import type { StreamDurableScopedClient } from './handler.ts';

describe('stream-durable-scoped client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('incoming');
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('outgoing');
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('requests');
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('streams');
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('namespaces');
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('channels');
  });
});

describe('StreamDurableScopedClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<StreamDurableScopedClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamDurableScopedClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamDurableScopedClient['requests']>().not.toBeAny();
    expectTypeOf<StreamDurableScopedClient['streams']>().not.toBeAny();
    expectTypeOf<StreamDurableScopedClient['channels']>().not.toBeAny();
    expectTypeOf<StreamDurableScopedClient['namespaces']>().not.toBeAny();
    expectTypeOf<StreamDurableScopedClient['__errors__']>().not.toBeAny();
  });
});
