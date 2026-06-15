import { describe, expectTypeOf, it } from 'vitest';
import type { ServerRequestClient } from './handler.ts';

describe('ServerRequestClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ServerRequestClient['incoming']>().not.toBeAny();
    expectTypeOf<ServerRequestClient['outgoing']>().not.toBeAny();
    expectTypeOf<ServerRequestClient['serverRequests']>().not.toBeAny();
  });
});

describe('ServerRequestClient — serverRequests slot flows through InferClient', () => {
  it('has ask-permission', () => {
    expectTypeOf<ServerRequestClient['serverRequests']>().toHaveProperty('ask-permission');
  });

  it('ask-permission carries the typed payload and response', () => {
    expectTypeOf<
      ServerRequestClient['serverRequests']['ask-permission']['payload']
    >().toEqualTypeOf<{ action: string }>();
    expectTypeOf<
      ServerRequestClient['serverRequests']['ask-permission']['response']
    >().toEqualTypeOf<{ allowed: boolean }>();
  });

  it('incoming (the client-sent triggers) and outgoing (the observable outcomes) are present', () => {
    expectTypeOf<ServerRequestClient['outgoing']>().toHaveProperty('trigger');
    expectTypeOf<ServerRequestClient['incoming']>().toHaveProperty('outcome');
    expectTypeOf<ServerRequestClient['incoming']>().toHaveProperty('error-outcome');
  });
});
