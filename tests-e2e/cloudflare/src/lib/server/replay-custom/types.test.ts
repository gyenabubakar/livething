import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayCustomClient } from './handler.ts';

describe('replay-custom client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplayCustomClient>().toHaveProperty('incoming');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('requests');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('streams');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('resumableStreams');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('recordedStreams');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplayCustomClient>().toHaveProperty('channels');
  });
});
