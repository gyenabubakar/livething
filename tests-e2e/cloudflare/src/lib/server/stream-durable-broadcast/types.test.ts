import { describe, expectTypeOf, it } from 'vitest';
import type { StreamDurableBroadcastClient } from './handler.ts';

describe('stream-durable-broadcast client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StreamDurableBroadcastClient>().toHaveProperty('incoming');
    expectTypeOf<StreamDurableBroadcastClient>().toHaveProperty('outgoing');
    expectTypeOf<StreamDurableBroadcastClient>().toHaveProperty('requests');
    expectTypeOf<StreamDurableBroadcastClient>().toHaveProperty('streams');
    expectTypeOf<StreamDurableBroadcastClient>().toHaveProperty('namespaces');
    expectTypeOf<StreamDurableBroadcastClient>().toHaveProperty('channels');
  });
});

describe('StreamDurableBroadcastClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<StreamDurableBroadcastClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamDurableBroadcastClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamDurableBroadcastClient['requests']>().not.toBeAny();
    expectTypeOf<StreamDurableBroadcastClient['streams']>().not.toBeAny();
    expectTypeOf<StreamDurableBroadcastClient['channels']>().not.toBeAny();
    expectTypeOf<StreamDurableBroadcastClient['namespaces']>().not.toBeAny();
    expectTypeOf<StreamDurableBroadcastClient['__errors__']>().not.toBeAny();
  });
});
