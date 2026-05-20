import { describe, expectTypeOf, it } from 'vitest';
import type { CtxKvClient } from './handler.ts';

describe('ctx-kv client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxKvClient>().toHaveProperty('incoming');
    expectTypeOf<CtxKvClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxKvClient>().toHaveProperty('requests');
    expectTypeOf<CtxKvClient>().toHaveProperty('streams');
    expectTypeOf<CtxKvClient>().toHaveProperty('resumableStreams');
    expectTypeOf<CtxKvClient>().toHaveProperty('recordedStreams');
    expectTypeOf<CtxKvClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxKvClient>().toHaveProperty('channels');
  });
});
