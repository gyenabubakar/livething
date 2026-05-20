import { describe, expectTypeOf, it } from 'vitest';
import type { CtxTagsClient } from './handler.ts';

describe('ctx-tags client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxTagsClient>().toHaveProperty('incoming');
    expectTypeOf<CtxTagsClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxTagsClient>().toHaveProperty('requests');
    expectTypeOf<CtxTagsClient>().toHaveProperty('streams');
    expectTypeOf<CtxTagsClient>().toHaveProperty('resumableStreams');
    expectTypeOf<CtxTagsClient>().toHaveProperty('recordedStreams');
    expectTypeOf<CtxTagsClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxTagsClient>().toHaveProperty('channels');
  });
});
