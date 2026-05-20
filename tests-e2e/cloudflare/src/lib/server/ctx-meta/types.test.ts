import { describe, expectTypeOf, it } from 'vitest';
import type { CtxMetaClient } from './handler.ts';

describe('ctx-meta client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxMetaClient>().toHaveProperty('incoming');
    expectTypeOf<CtxMetaClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxMetaClient>().toHaveProperty('requests');
    expectTypeOf<CtxMetaClient>().toHaveProperty('streams');
    expectTypeOf<CtxMetaClient>().toHaveProperty('resumableStreams');
    expectTypeOf<CtxMetaClient>().toHaveProperty('recordedStreams');
    expectTypeOf<CtxMetaClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxMetaClient>().toHaveProperty('channels');
  });
});
