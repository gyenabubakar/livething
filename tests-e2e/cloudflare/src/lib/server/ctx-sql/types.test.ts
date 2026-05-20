import { describe, expectTypeOf, it } from 'vitest';
import type { CtxSqlClient } from './handler.ts';

describe('ctx-sql client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxSqlClient>().toHaveProperty('incoming');
    expectTypeOf<CtxSqlClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxSqlClient>().toHaveProperty('requests');
    expectTypeOf<CtxSqlClient>().toHaveProperty('streams');
    expectTypeOf<CtxSqlClient>().toHaveProperty('resumableStreams');
    expectTypeOf<CtxSqlClient>().toHaveProperty('recordedStreams');
    expectTypeOf<CtxSqlClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxSqlClient>().toHaveProperty('channels');
  });
});
