import { describe, expectTypeOf, it } from 'vitest';
import type { ServerAckClient } from './handler.ts';

describe('ServerAckClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ServerAckClient['incoming']>().not.toBeAny();
    expectTypeOf<ServerAckClient['outgoing']>().not.toBeAny();
  });
});

describe('ServerAckClient — observable surface', () => {
  it('incoming carries the triggers and outgoing carries the observable outcomes', () => {
    expectTypeOf<ServerAckClient['outgoing']>().toHaveProperty('trigger');
    expectTypeOf<ServerAckClient['outgoing']>().toHaveProperty('trigger-timeout');
    // The acked event the server pushes, plus the test-observable outcomes.
    expectTypeOf<ServerAckClient['incoming']>().toHaveProperty('settings-updated');
    expectTypeOf<ServerAckClient['incoming']>().toHaveProperty('ack-outcome');
    expectTypeOf<ServerAckClient['incoming']>().toHaveProperty('ack-error');
  });
});
