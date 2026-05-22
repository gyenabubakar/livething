import { describe, expectTypeOf, it } from 'vitest';
import type { CtxMetaClient } from './handler.ts';

describe('ctx-meta client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxMetaClient>().toHaveProperty('incoming');
    expectTypeOf<CtxMetaClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxMetaClient>().toHaveProperty('requests');
    expectTypeOf<CtxMetaClient>().toHaveProperty('streams');
    expectTypeOf<CtxMetaClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxMetaClient>().toHaveProperty('channels');
  });
});

describe('CtxMetaClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<CtxMetaClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxMetaClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxMetaClient['requests']>().not.toBeAny();
    expectTypeOf<CtxMetaClient['streams']>().not.toBeAny();
    expectTypeOf<CtxMetaClient['channels']>().not.toBeAny();
    expectTypeOf<CtxMetaClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxMetaClient['__errors__']>().not.toBeAny();
  });
});
