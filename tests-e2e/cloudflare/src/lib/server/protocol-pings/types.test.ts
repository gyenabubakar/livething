import { describe, expectTypeOf, it } from 'vitest';
import type { ProtocolPingsClient } from './handler.ts';

describe('protocol-pings client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('incoming');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('outgoing');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('requests');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('streams');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('resumableStreams');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('recordedStreams');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('namespaces');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('channels');
  });
});
