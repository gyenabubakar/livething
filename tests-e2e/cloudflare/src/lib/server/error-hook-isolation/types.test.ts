import { describe, expectTypeOf, it } from 'vitest';
import type { ErrorHookIsolationClient } from './handler.ts';

describe('error-hook-isolation client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ErrorHookIsolationClient>().toHaveProperty('incoming');
    expectTypeOf<ErrorHookIsolationClient>().toHaveProperty('outgoing');
    expectTypeOf<ErrorHookIsolationClient>().toHaveProperty('requests');
    expectTypeOf<ErrorHookIsolationClient>().toHaveProperty('streams');
    expectTypeOf<ErrorHookIsolationClient>().toHaveProperty('namespaces');
    expectTypeOf<ErrorHookIsolationClient>().toHaveProperty('channels');
  });
});
