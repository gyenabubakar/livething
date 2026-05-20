import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelKeyCollisionClient } from './handler.ts';

describe('channel-key-collision client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('incoming');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('outgoing');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('requests');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('streams');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('resumableStreams');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('recordedStreams');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('namespaces');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('channels');
  });
});
