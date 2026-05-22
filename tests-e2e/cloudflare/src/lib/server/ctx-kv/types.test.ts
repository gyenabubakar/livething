import { describe, expectTypeOf, it } from 'vitest';
import type { CtxKvClient } from './handler.ts';

describe('ctx-kv client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxKvClient>().toHaveProperty('incoming');
    expectTypeOf<CtxKvClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxKvClient>().toHaveProperty('requests');
    expectTypeOf<CtxKvClient>().toHaveProperty('streams');
    expectTypeOf<CtxKvClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxKvClient>().toHaveProperty('channels');
  });
});

describe('CtxKvClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<CtxKvClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxKvClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxKvClient['requests']>().not.toBeAny();
    expectTypeOf<CtxKvClient['streams']>().not.toBeAny();
    expectTypeOf<CtxKvClient['channels']>().not.toBeAny();
    expectTypeOf<CtxKvClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxKvClient['__errors__']>().not.toBeAny();
  });
});
