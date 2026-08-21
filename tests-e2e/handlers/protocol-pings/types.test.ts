import { describe, expectTypeOf, it } from 'vitest';
import type { ProtocolPingsClient } from './handler.ts';

describe('ProtocolPingsClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ProtocolPingsClient['incoming']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['outgoing']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['clientRequests']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['streams']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['channels']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['errors']>().not.toBeAny();
  });
});

describe('ProtocolPingsClient — all slots are empty (no definitions)', () => {
  it('incoming is empty', () => {
    expectTypeOf<keyof ProtocolPingsClient['incoming']>().toBeNever();
  });

  it('outgoing is empty', () => {
    expectTypeOf<keyof ProtocolPingsClient['outgoing']>().toBeNever();
  });

  it('clientRequests is empty', () => {
    expectTypeOf<keyof ProtocolPingsClient['clientRequests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ProtocolPingsClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof ProtocolPingsClient['channels']>().toBeNever();
  });
});

describe('ProtocolPingsClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ProtocolPingsClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ProtocolPingsClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ProtocolPingsClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ProtocolPingsClient['errors']>().toHaveProperty('internal-error');
  });
});
