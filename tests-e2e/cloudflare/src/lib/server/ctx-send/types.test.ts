import { describe, expectTypeOf, it } from 'vitest';
import type { CtxSendClient } from './handler.ts';

describe('ctx-send client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxSendClient>().toHaveProperty('incoming');
    expectTypeOf<CtxSendClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxSendClient>().toHaveProperty('requests');
    expectTypeOf<CtxSendClient>().toHaveProperty('streams');
    expectTypeOf<CtxSendClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxSendClient>().toHaveProperty('channels');
  });
});

describe('CtxSendClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<CtxSendClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxSendClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxSendClient['requests']>().not.toBeAny();
    expectTypeOf<CtxSendClient['streams']>().not.toBeAny();
    expectTypeOf<CtxSendClient['channels']>().not.toBeAny();
    expectTypeOf<CtxSendClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxSendClient['__errors__']>().not.toBeAny();
  });
});
