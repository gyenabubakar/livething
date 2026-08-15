import { describe, expectTypeOf, it } from 'vitest';
import type { BroadcastRequestClient } from './handler.ts';

describe('BroadcastRequestClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<BroadcastRequestClient['incoming']>().not.toBeAny();
    expectTypeOf<BroadcastRequestClient['outgoing']>().not.toBeAny();
    expectTypeOf<BroadcastRequestClient['serverRequests']>().not.toBeAny();
  });
});

describe('BroadcastRequestClient — channel broadcast serverRequests flows through InferClient', () => {
  it('carries the lobby channel volunteer broadcast request, typed', () => {
    type LobbyRequests = BroadcastRequestClient['channels']['lobby']['serverRequests'];
    expectTypeOf<LobbyRequests>().toHaveProperty('volunteer');
    expectTypeOf<LobbyRequests['volunteer']['payload']>().toEqualTypeOf<{ turn: number }>();
    expectTypeOf<LobbyRequests['volunteer']['response']>().toEqualTypeOf<{ ready: boolean }>();
  });

  it('the observable triggers and outcomes are present', () => {
    expectTypeOf<BroadcastRequestClient['outgoing']>().toHaveProperty('trigger');
    expectTypeOf<BroadcastRequestClient['incoming']>().toHaveProperty('outcome');
    expectTypeOf<BroadcastRequestClient['incoming']>().toHaveProperty('error-outcome');
  });
});
