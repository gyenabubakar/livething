import { describe, expectTypeOf, it } from 'vitest';
import type { ModulesClient } from './handler.ts';

describe('modules client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ModulesClient>().toHaveProperty('incoming');
    expectTypeOf<ModulesClient>().toHaveProperty('outgoing');
    expectTypeOf<ModulesClient>().toHaveProperty('requests');
    expectTypeOf<ModulesClient>().toHaveProperty('streams');
    expectTypeOf<ModulesClient>().toHaveProperty('namespaces');
    expectTypeOf<ModulesClient>().toHaveProperty('channels');
  });
});
