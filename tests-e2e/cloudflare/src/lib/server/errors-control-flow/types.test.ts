import { describe, expectTypeOf, it } from 'vitest';
import type { ErrorsControlFlowClient } from './handler.ts';

describe('errors-control-flow client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('incoming');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('outgoing');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('requests');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('streams');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('namespaces');
    expectTypeOf<ErrorsControlFlowClient>().toHaveProperty('channels');
  });
});

describe('ErrorsControlFlowClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ErrorsControlFlowClient['incoming']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['outgoing']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['requests']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['streams']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['channels']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['namespaces']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['__errors__']>().not.toBeAny();
  });
});
