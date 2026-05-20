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
