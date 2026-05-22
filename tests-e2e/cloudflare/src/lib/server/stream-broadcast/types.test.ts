import { describe, expectTypeOf, it } from 'vitest';
import type { StreamBroadcastClient } from './handler.ts';

describe('stream-broadcast client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('incoming');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('outgoing');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('requests');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('streams');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('namespaces');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('channels');
  });
});

describe('StreamBroadcastClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<StreamBroadcastClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['requests']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['streams']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['channels']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['namespaces']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['__errors__']>().not.toBeAny();
  });
});
