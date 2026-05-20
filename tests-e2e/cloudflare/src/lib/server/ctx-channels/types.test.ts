import { describe, expectTypeOf, it } from 'vitest';
import type { CtxChannelsClient } from './handler.ts';

describe('ctx-channels client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxChannelsClient>().toHaveProperty('incoming');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('requests');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('streams');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('resumableStreams');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('recordedStreams');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('channels');
  });
});
