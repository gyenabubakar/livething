import { describe, expectTypeOf, it } from 'vitest';
import type { HeartbeatClient } from './handler.ts';

describe('heartbeat client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<HeartbeatClient>().toHaveProperty('incoming');
    expectTypeOf<HeartbeatClient>().toHaveProperty('outgoing');
    expectTypeOf<HeartbeatClient>().toHaveProperty('requests');
    expectTypeOf<HeartbeatClient>().toHaveProperty('streams');
    expectTypeOf<HeartbeatClient>().toHaveProperty('resumableStreams');
    expectTypeOf<HeartbeatClient>().toHaveProperty('recordedStreams');
    expectTypeOf<HeartbeatClient>().toHaveProperty('namespaces');
    expectTypeOf<HeartbeatClient>().toHaveProperty('channels');
  });
});
