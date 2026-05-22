import { describe, expectTypeOf, it } from 'vitest';
import type { HeartbeatClient } from './handler.ts';

describe('HeartbeatClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<HeartbeatClient['incoming']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['outgoing']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['requests']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['streams']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['channels']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['namespaces']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['errors']>().not.toBeAny();
  });
});

describe('HeartbeatClient — all slots are empty (no definitions)', () => {
  it('incoming is empty', () => {
    expectTypeOf<keyof HeartbeatClient['incoming']>().toBeNever();
  });

  it('outgoing is empty', () => {
    expectTypeOf<keyof HeartbeatClient['outgoing']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof HeartbeatClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof HeartbeatClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof HeartbeatClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof HeartbeatClient['namespaces']>().toBeNever();
  });
});

describe('HeartbeatClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<HeartbeatClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<HeartbeatClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<HeartbeatClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<HeartbeatClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<HeartbeatClient['errors']>().toHaveProperty('internal-error');
  });
});
