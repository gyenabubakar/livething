import { describe, expectTypeOf, it } from 'vitest';
import type { CtxSendClient } from './handler.ts';

describe('ctx-send client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<CtxSendClient>().toHaveProperty('incoming');
    expectTypeOf<CtxSendClient>().toHaveProperty('outgoing');
    expectTypeOf<CtxSendClient>().toHaveProperty('requests');
    expectTypeOf<CtxSendClient>().toHaveProperty('streams');
    expectTypeOf<CtxSendClient>().toHaveProperty('namespaces');
    expectTypeOf<CtxSendClient>().toHaveProperty('channels');
  });
});
