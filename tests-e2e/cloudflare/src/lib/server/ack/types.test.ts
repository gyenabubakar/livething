import { describe, expectTypeOf, it } from 'vitest';
import type { AckClient } from './handler.ts';

describe('ack client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<AckClient>().toHaveProperty('incoming');
    expectTypeOf<AckClient>().toHaveProperty('outgoing');
    expectTypeOf<AckClient>().toHaveProperty('requests');
    expectTypeOf<AckClient>().toHaveProperty('streams');
    expectTypeOf<AckClient>().toHaveProperty('resumableStreams');
    expectTypeOf<AckClient>().toHaveProperty('recordedStreams');
    expectTypeOf<AckClient>().toHaveProperty('namespaces');
    expectTypeOf<AckClient>().toHaveProperty('channels');
  });
});
