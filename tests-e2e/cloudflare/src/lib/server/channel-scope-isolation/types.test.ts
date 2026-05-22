import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelScopeIsolationClient } from './handler.ts';

describe('channel-scope-isolation client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('incoming');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('outgoing');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('requests');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('streams');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('namespaces');
    expectTypeOf<ChannelScopeIsolationClient>().toHaveProperty('channels');
  });
});

describe('ChannelScopeIsolationClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ChannelScopeIsolationClient['incoming']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['outgoing']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['requests']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['streams']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['channels']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['namespaces']>().not.toBeAny();
    expectTypeOf<ChannelScopeIsolationClient['__errors__']>().not.toBeAny();
  });
});
