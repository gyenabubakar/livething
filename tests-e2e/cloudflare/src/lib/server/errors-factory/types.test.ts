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
