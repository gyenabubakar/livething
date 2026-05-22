import { describe, expectTypeOf, it } from 'vitest';
import type { CtxChannelsClient } from './handler.ts';

describe('ctx-channels client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxChannelsClient>().toHaveProperty('incoming');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('requests');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('streams');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxChannelsClient>().toHaveProperty('channels');
  });
});

describe('CtxChannelsClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<CtxChannelsClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['requests']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['streams']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['channels']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxChannelsClient['__errors__']>().not.toBeAny();
  });
});
