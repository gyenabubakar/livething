import { describe, expectTypeOf, it } from 'vitest';
import type { TypedTagsClient } from './handler.ts';

describe('typed-tags client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<TypedTagsClient>().toHaveProperty('incoming');
    expectTypeOf<TypedTagsClient>().toHaveProperty('outgoing');
    expectTypeOf<TypedTagsClient>().toHaveProperty('requests');
    expectTypeOf<TypedTagsClient>().toHaveProperty('streams');
    expectTypeOf<TypedTagsClient>().toHaveProperty('resumableStreams');
    expectTypeOf<TypedTagsClient>().toHaveProperty('recordedStreams');
    expectTypeOf<TypedTagsClient>().toHaveProperty('namespaces');
    expectTypeOf<TypedTagsClient>().toHaveProperty('channels');
  });
});
