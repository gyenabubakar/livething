import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayMembershipGateClient } from './handler.ts';

describe('replay-membership-gate client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('incoming');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('requests');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('streams');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('resumableStreams');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('recordedStreams');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('channels');
  });
});
