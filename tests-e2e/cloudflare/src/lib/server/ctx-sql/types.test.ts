import { describe, expectTypeOf, it } from 'vitest';
import type { CtxSqlClient } from './handler.ts';

describe('ctx-sql client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxSqlClient>().toHaveProperty('incoming');
    expectTypeOf<CtxSqlClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxSqlClient>().toHaveProperty('requests');
    expectTypeOf<CtxSqlClient>().toHaveProperty('streams');
    expectTypeOf<CtxSqlClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxSqlClient>().toHaveProperty('channels');
  });
});

describe('CtxSqlClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<CtxSqlClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxSqlClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxSqlClient['requests']>().not.toBeAny();
    expectTypeOf<CtxSqlClient['streams']>().not.toBeAny();
    expectTypeOf<CtxSqlClient['channels']>().not.toBeAny();
    expectTypeOf<CtxSqlClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxSqlClient['__errors__']>().not.toBeAny();
  });
});
