import { describe, expectTypeOf, it } from 'vitest';
import type { StreamNudgesClient } from './handler.ts';

describe('stream-nudges client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StreamNudgesClient>().toHaveProperty('incoming');
    expectTypeOf<StreamNudgesClient>().toHaveProperty('outgoing');
    expectTypeOf<StreamNudgesClient>().toHaveProperty('requests');
    expectTypeOf<StreamNudgesClient>().toHaveProperty('streams');
    expectTypeOf<StreamNudgesClient>().toHaveProperty('namespaces');
    expectTypeOf<StreamNudgesClient>().toHaveProperty('channels');
  });
});
