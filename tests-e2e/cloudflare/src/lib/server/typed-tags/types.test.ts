import { describe, expectTypeOf, it } from 'vitest';
import type { TypedTagsClient } from './handler.ts';

describe('typed-tags client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<TypedTagsClient>().toHaveProperty('incoming');
    expectTypeOf<TypedTagsClient>().toHaveProperty('outgoing');
    expectTypeOf<TypedTagsClient>().toHaveProperty('requests');
    expectTypeOf<TypedTagsClient>().toHaveProperty('streams');
    expectTypeOf<TypedTagsClient>().toHaveProperty('namespaces');
    expectTypeOf<TypedTagsClient>().toHaveProperty('channels');
  });
});

describe('TypedTagsClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<TypedTagsClient['incoming']>().not.toBeAny();
    expectTypeOf<TypedTagsClient['outgoing']>().not.toBeAny();
    expectTypeOf<TypedTagsClient['requests']>().not.toBeAny();
    expectTypeOf<TypedTagsClient['streams']>().not.toBeAny();
    expectTypeOf<TypedTagsClient['channels']>().not.toBeAny();
    expectTypeOf<TypedTagsClient['namespaces']>().not.toBeAny();
    expectTypeOf<TypedTagsClient['__errors__']>().not.toBeAny();
  });
});
