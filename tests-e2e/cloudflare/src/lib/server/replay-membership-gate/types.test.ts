import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayMembershipGateClient } from './handler.ts';

describe('replay-membership-gate client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('incoming');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('outgoing');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('requests');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('streams');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('namespaces');
    expectTypeOf<ReplayMembershipGateClient>().toHaveProperty('channels');
  });
});

describe('ReplayMembershipGateClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ReplayMembershipGateClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['requests']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['streams']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['channels']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['namespaces']>().not.toBeAny();
    expectTypeOf<ReplayMembershipGateClient['__errors__']>().not.toBeAny();
  });
});
