import { describe, expectTypeOf, it } from 'vitest';
import type { ErrorsFactoryClient } from './handler.ts';

describe('errors-factory client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ErrorsFactoryClient>().toHaveProperty('incoming');
    expectTypeOf<ErrorsFactoryClient>().toHaveProperty('outgoing');
    expectTypeOf<ErrorsFactoryClient>().toHaveProperty('requests');
    expectTypeOf<ErrorsFactoryClient>().toHaveProperty('streams');
    expectTypeOf<ErrorsFactoryClient>().toHaveProperty('namespaces');
    expectTypeOf<ErrorsFactoryClient>().toHaveProperty('channels');
  });
});

describe('ErrorsFactoryClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ErrorsFactoryClient['incoming']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['outgoing']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['requests']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['streams']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['channels']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['namespaces']>().not.toBeAny();
    expectTypeOf<ErrorsFactoryClient['__errors__']>().not.toBeAny();
  });
});
