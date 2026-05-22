import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelKeyCollisionClient } from './handler.ts';

describe('channel-key-collision client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('incoming');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('outgoing');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('requests');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('streams');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('namespaces');
    expectTypeOf<ChannelKeyCollisionClient>().toHaveProperty('channels');
  });
});

describe('ChannelKeyCollisionClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ChannelKeyCollisionClient['incoming']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['outgoing']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['requests']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['streams']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['channels']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['namespaces']>().not.toBeAny();
    expectTypeOf<ChannelKeyCollisionClient['__errors__']>().not.toBeAny();
  });
});
