import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelStaticClient } from './handler.ts';

describe('channel-static client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ChannelStaticClient>().toHaveProperty('incoming');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('outgoing');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('requests');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('streams');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('namespaces');
    expectTypeOf<ChannelStaticClient>().toHaveProperty('channels');
  });
});

describe('ChannelStaticClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ChannelStaticClient['incoming']>().not.toBeAny();
    expectTypeOf<ChannelStaticClient['outgoing']>().not.toBeAny();
    expectTypeOf<ChannelStaticClient['requests']>().not.toBeAny();
    expectTypeOf<ChannelStaticClient['streams']>().not.toBeAny();
    expectTypeOf<ChannelStaticClient['channels']>().not.toBeAny();
    expectTypeOf<ChannelStaticClient['namespaces']>().not.toBeAny();
    expectTypeOf<ChannelStaticClient['__errors__']>().not.toBeAny();
  });
});
