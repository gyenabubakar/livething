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

describe('ErrorHookIsolationClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ErrorHookIsolationClient['incoming']>().not.toBeAny();
    expectTypeOf<ErrorHookIsolationClient['outgoing']>().not.toBeAny();
    expectTypeOf<ErrorHookIsolationClient['requests']>().not.toBeAny();
    expectTypeOf<ErrorHookIsolationClient['streams']>().not.toBeAny();
    expectTypeOf<ErrorHookIsolationClient['channels']>().not.toBeAny();
    expectTypeOf<ErrorHookIsolationClient['namespaces']>().not.toBeAny();
    expectTypeOf<ErrorHookIsolationClient['__errors__']>().not.toBeAny();
  });
});
