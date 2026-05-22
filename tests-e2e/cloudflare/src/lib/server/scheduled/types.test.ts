import { describe, expectTypeOf, it } from 'vitest';
import type { ScheduledClient } from './handler.ts';

describe('scheduled client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ScheduledClient>().toHaveProperty('incoming');
    expectTypeOf<ScheduledClient>().toHaveProperty('outgoing');
    expectTypeOf<ScheduledClient>().toHaveProperty('requests');
    expectTypeOf<ScheduledClient>().toHaveProperty('streams');
    expectTypeOf<ScheduledClient>().toHaveProperty('namespaces');
    expectTypeOf<ScheduledClient>().toHaveProperty('channels');
  });
});

describe('ScheduledClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ScheduledClient['incoming']>().not.toBeAny();
    expectTypeOf<ScheduledClient['outgoing']>().not.toBeAny();
    expectTypeOf<ScheduledClient['requests']>().not.toBeAny();
    expectTypeOf<ScheduledClient['streams']>().not.toBeAny();
    expectTypeOf<ScheduledClient['channels']>().not.toBeAny();
    expectTypeOf<ScheduledClient['namespaces']>().not.toBeAny();
    expectTypeOf<ScheduledClient['__errors__']>().not.toBeAny();
  });
});
