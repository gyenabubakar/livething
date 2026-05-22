import { describe, expectTypeOf, it } from 'vitest';
import type { PersistenceClient } from './handler.ts';

describe('PersistenceClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<PersistenceClient['incoming']>().not.toBeAny();
    expectTypeOf<PersistenceClient['outgoing']>().not.toBeAny();
    expectTypeOf<PersistenceClient['requests']>().not.toBeAny();
    expectTypeOf<PersistenceClient['streams']>().not.toBeAny();
    expectTypeOf<PersistenceClient['channels']>().not.toBeAny();
    expectTypeOf<PersistenceClient['namespaces']>().not.toBeAny();
    expectTypeOf<PersistenceClient['__errors__']>().not.toBeAny();
  });
});

describe('PersistenceClient — incoming (server outgoing)', () => {
  it('has true-leave', () => {
    expectTypeOf<PersistenceClient['incoming']['true-leave']>().toEqualTypeOf<{
      channel: string;
      username: string;
    }>();
  });

  it('only true-leave in top-level incoming', () => {
    expectTypeOf<keyof PersistenceClient['incoming']>().toEqualTypeOf<'true-leave'>();
  });
});

describe('PersistenceClient — outgoing (server incoming)', () => {
  it('has remove-member', () => {
    expectTypeOf<PersistenceClient['outgoing']['remove-member']>().toEqualTypeOf<{
      identity: string;
    }>();
  });

  it('only remove-member in outgoing', () => {
    expectTypeOf<keyof PersistenceClient['outgoing']>().toEqualTypeOf<'remove-member'>();
  });
});

describe('PersistenceClient — channels', () => {
  it('has archive-room channel', () => {
    expectTypeOf<PersistenceClient['channels']>().toHaveProperty('archive-room');
  });

  it('has typing-indicator channel', () => {
    expectTypeOf<PersistenceClient['channels']>().toHaveProperty('typing-indicator');
  });

  it('archive-room incoming has room-message', () => {
    expectTypeOf<
      PersistenceClient['channels']['archive-room']['incoming']['room-message']
    >().toEqualTypeOf<{ text: string; from: string }>();
  });

  it('archive-room incoming has session-ended', () => {
    expectTypeOf<
      PersistenceClient['channels']['archive-room']['incoming']['session-ended']
    >().toEqualTypeOf<{ channel: string; username: string }>();
  });

  it('archive-room outgoing has send-message (server incoming)', () => {
    expectTypeOf<
      PersistenceClient['channels']['archive-room']['outgoing']['send-message']
    >().toEqualTypeOf<{ text: string }>();
  });

  it('typing-indicator incoming has room-message', () => {
    expectTypeOf<
      PersistenceClient['channels']['typing-indicator']['incoming']['room-message']
    >().toEqualTypeOf<{ text: string; from: string }>();
  });

  it('typing-indicator outgoing is empty', () => {
    expectTypeOf<keyof PersistenceClient['channels']['typing-indicator']['outgoing']>().toBeNever();
  });
});

describe('PersistenceClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof PersistenceClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof PersistenceClient['streams']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof PersistenceClient['namespaces']>().toBeNever();
  });
});

describe('PersistenceClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<PersistenceClient['__errors__']>().toHaveProperty('validation-failed');
    expectTypeOf<PersistenceClient['__errors__']>().toHaveProperty('channel-not-found');
    expectTypeOf<PersistenceClient['__errors__']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<PersistenceClient['__errors__']>().toHaveProperty('namespace-not-found');
    expectTypeOf<PersistenceClient['__errors__']>().toHaveProperty('internal-error');
  });
});
