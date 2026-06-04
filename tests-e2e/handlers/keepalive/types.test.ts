import { describe, expectTypeOf, it } from 'vitest';
import type { KeepaliveClient } from './handler.ts';

describe('KeepaliveClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<KeepaliveClient['incoming']>().not.toBeAny();
    expectTypeOf<KeepaliveClient['outgoing']>().not.toBeAny();
    expectTypeOf<KeepaliveClient['requests']>().not.toBeAny();
    expectTypeOf<KeepaliveClient['streams']>().not.toBeAny();
    expectTypeOf<KeepaliveClient['channels']>().not.toBeAny();
    expectTypeOf<KeepaliveClient['namespaces']>().not.toBeAny();
    expectTypeOf<KeepaliveClient['errors']>().not.toBeAny();
  });
});

describe('KeepaliveClient — all slots are empty (no definitions)', () => {
  it('incoming is empty', () => {
    expectTypeOf<keyof KeepaliveClient['incoming']>().toBeNever();
  });

  it('outgoing is empty', () => {
    expectTypeOf<keyof KeepaliveClient['outgoing']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof KeepaliveClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof KeepaliveClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof KeepaliveClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof KeepaliveClient['namespaces']>().toBeNever();
  });
});

describe('KeepaliveClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<KeepaliveClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<KeepaliveClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<KeepaliveClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<KeepaliveClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<KeepaliveClient['errors']>().toHaveProperty('internal-error');
  });
});
