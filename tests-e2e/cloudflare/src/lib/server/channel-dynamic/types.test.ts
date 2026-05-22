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

describe('ChannelDynamicClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ChannelDynamicClient['incoming']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['outgoing']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['requests']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['streams']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['channels']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['namespaces']>().not.toBeAny();
    expectTypeOf<ChannelDynamicClient['__errors__']>().not.toBeAny();
  });
});
