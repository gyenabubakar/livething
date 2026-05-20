import { describe, expectTypeOf, it } from 'vitest';
import type { ErrorsControlFlowClient } from './handler.ts';

describe('errors-control-flow client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('incoming');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('outgoing');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('requests');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('streams');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('resumableStreams');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('recordedStreams');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('namespaces');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('channels');
  });
});
