import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelDynamicClient } from './handler.ts';

describe('channel-dynamic client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ChannelDynamicClient>().toHaveProperty('incoming');
    expectTypeOf<ChannelDynamicClient>().toHaveProperty('outgoing');
    expectTypeOf<ChannelDynamicClient>().toHaveProperty('requests');
    expectTypeOf<ChannelDynamicClient>().toHaveProperty('streams');
    expectTypeOf<ChannelDynamicClient>().toHaveProperty('namespaces');
    expectTypeOf<ChannelDynamicClient>().toHaveProperty('channels');
  });
});
