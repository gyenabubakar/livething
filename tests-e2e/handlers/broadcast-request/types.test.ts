import { describe, expectTypeOf, it } from 'vitest';
import type { BroadcastRequestClient } from './handler.ts';

describe('BroadcastRequestClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<BroadcastRequestClient['incoming']>().not.toBeAny();
    expectTypeOf<BroadcastRequestClient['outgoing']>().not.toBeAny();
    expectTypeOf<BroadcastRequestClient['serverRequests']>().not.toBeAny();
  });
});

describe('BroadcastRequestClient — broadcast serverRequest flows through InferClient', () => {
  it('carries the volunteer broadcast request, typed', () => {
    expectTypeOf<BroadcastRequestClient['serverRequests']>().toHaveProperty('volunteer');
    expectTypeOf<BroadcastRequestClient['serverRequests']['volunteer']['payload']>().toEqualTypeOf<{
      turn: number;
    }>();
    expectTypeOf<
      BroadcastRequestClient['serverRequests']['volunteer']['response']
    >().toEqualTypeOf<{ ready: boolean }>();
  });

  it('the observable triggers and outcomes are present', () => {
    expectTypeOf<BroadcastRequestClient['outgoing']>().toHaveProperty('trigger');
    expectTypeOf<BroadcastRequestClient['incoming']>().toHaveProperty('outcome');
    expectTypeOf<BroadcastRequestClient['incoming']>().toHaveProperty('error-outcome');
  });
});
