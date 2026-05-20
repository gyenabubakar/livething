import { describe, expectTypeOf, it } from 'vitest';
import type { StreamBroadcastClient } from './handler.ts';

describe('stream-broadcast client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('incoming');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('outgoing');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('requests');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('streams');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('resumableStreams');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('recordedStreams');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('namespaces');
    expectTypeOf<StreamBroadcastClient>().toHaveProperty('channels');
  });
});
