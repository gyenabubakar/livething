import { describe, expectTypeOf, it } from 'vitest';
import type { CtxQualityClient } from './handler.ts';

describe('ctx-quality client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxQualityClient>().toHaveProperty('incoming');
    expectTypeOf<CtxQualityClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxQualityClient>().toHaveProperty('requests');
    expectTypeOf<CtxQualityClient>().toHaveProperty('streams');
    expectTypeOf<CtxQualityClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxQualityClient>().toHaveProperty('channels');
  });
});

describe('CtxQualityClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<CtxQualityClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['requests']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['streams']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['channels']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['__errors__']>().not.toBeAny();
  });
});
