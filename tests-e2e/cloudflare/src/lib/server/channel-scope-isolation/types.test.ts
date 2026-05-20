import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelScopeIsolationClient } from './handler.ts';

describe('channel-scope-isolation client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('incoming');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('outgoing');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('requests');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('streams');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('resumableStreams');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('recordedStreams');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('namespaces');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('channels');
  });
});
