import { describe, expectTypeOf, it } from 'vitest';
import type { ProtocolPingsClient } from './handler.ts';

describe('ProtocolPingsClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ProtocolPingsClient['incoming']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['outgoing']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['requests']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['streams']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['channels']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['namespaces']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['__errors__']>().not.toBeAny();
  });
});

describe('ProtocolPingsClient — all slots are empty (no definitions)', () => {
  it('incoming is empty', () => {
    expectTypeOf<keyof ProtocolPingsClient['incoming']>().toBeNever();
  });

  it('outgoing is empty', () => {
    expectTypeOf<keyof ProtocolPingsClient['outgoing']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof ProtocolPingsClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ProtocolPingsClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof ProtocolPingsClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof ProtocolPingsClient['namespaces']>().toBeNever();
  });
});

describe('ProtocolPingsClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ProtocolPingsClient['__errors__']>().toHaveProperty('validation-failed');
    expectTypeOf<ProtocolPingsClient['__errors__']>().toHaveProperty('channel-not-found');
    expectTypeOf<ProtocolPingsClient['__errors__']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ProtocolPingsClient['__errors__']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ProtocolPingsClient['__errors__']>().toHaveProperty('internal-error');
  });
});
