import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayFamilyKeyEqualsNameClient } from './handler.ts';

describe('replay-family-key-equals-name client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('incoming');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('requests');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('streams');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('resumableStreams');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('recordedStreams');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplayFamilyKeyEqualsNameClient>().toHaveProperty('channels');
  });
});
