import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelStaticClient } from './handler.ts';

describe('channel-static client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ChannelStaticClient>().toHaveProperty('incoming');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('outgoing');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('requests');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('streams');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('resumableStreams');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('recordedStreams');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('namespaces');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('channels');
  });
});
