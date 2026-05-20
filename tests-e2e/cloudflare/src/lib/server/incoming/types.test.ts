import { describe, expectTypeOf, it } from 'vitest';
import type { IncomingClient } from './handler.ts';

describe('incoming client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<IncomingClient>().toHaveProperty('incoming');
    expectTypeOf<IncomingClient>().toHaveProperty('outgoing');
    expectTypeOf<IncomingClient>().toHaveProperty('requests');
    expectTypeOf<IncomingClient>().toHaveProperty('streams');
    expectTypeOf<IncomingClient>().toHaveProperty('resumableStreams');
    expectTypeOf<IncomingClient>().toHaveProperty('recordedStreams');
    expectTypeOf<IncomingClient>().toHaveProperty('namespaces');
    expectTypeOf<IncomingClient>().toHaveProperty('channels');
  });
});
