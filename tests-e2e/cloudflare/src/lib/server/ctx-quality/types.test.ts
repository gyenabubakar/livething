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
