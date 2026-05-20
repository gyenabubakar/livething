import { describe, expectTypeOf, it } from 'vitest';
import type { ScheduledClient } from './handler.ts';

describe('scheduled client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ScheduledClient>().toHaveProperty('incoming');
    expectTypeOf<ScheduledClient>().toHaveProperty('outgoing');
    expectTypeOf<ScheduledClient>().toHaveProperty('requests');
    expectTypeOf<ScheduledClient>().toHaveProperty('streams');
    expectTypeOf<ScheduledClient>().toHaveProperty('resumableStreams');
    expectTypeOf<ScheduledClient>().toHaveProperty('recordedStreams');
    expectTypeOf<ScheduledClient>().toHaveProperty('namespaces');
    expectTypeOf<ScheduledClient>().toHaveProperty('channels');
  });
});
