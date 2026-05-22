import { describe, expectTypeOf, it } from 'vitest';
import type { CtxTagsClient } from './handler.ts';

describe('ctx-tags client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxTagsClient>().toHaveProperty('incoming');
    expectTypeOf<CtxTagsClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxTagsClient>().toHaveProperty('requests');
    expectTypeOf<CtxTagsClient>().toHaveProperty('streams');
    expectTypeOf<CtxTagsClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxTagsClient>().toHaveProperty('channels');
  });
});

describe('CtxTagsClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<CtxTagsClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['requests']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['streams']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['channels']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['__errors__']>().not.toBeAny();
  });
});
