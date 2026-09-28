import { describe, expectTypeOf, it } from 'vitest';
import type { PersistenceClient } from './handler.ts';

describe('PersistenceClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<PersistenceClient['incoming']>().not.toBeAny();
    expectTypeOf<PersistenceClient['outgoing']>().not.toBeAny();
    expectTypeOf<PersistenceClient['clientRequests']>().not.toBeAny();
    expectTypeOf<PersistenceClient['streams']>().not.toBeAny();
    expectTypeOf<PersistenceClient['channels']>().not.toBeAny();

    expectTypeOf<PersistenceClient['errors']>().not.toBeAny();
  });
});

describe('PersistenceClient — incoming (server outgoing)', () => {
  it('has true-leave', () => {
    expectTypeOf<PersistenceClient['incoming']['true-leave']>().toEqualTypeOf<{
      channel: string;
      username: string;
    }>();
  });

  it('has the declared top-level incoming events', () => {
    expectTypeOf<keyof PersistenceClient['incoming']>().toEqualTypeOf<
      'true-leave' | 'subscribe-flow-ran'
    >();
  });
});

describe('PersistenceClient — outgoing (server incoming)', () => {
  it('has remove-member', () => {
    expectTypeOf<PersistenceClient['outgoing']['remove-member']>().toEqualTypeOf<{
      identity: string;
    }>();
  });

  it('has the declared top-level outgoing events', () => {
    expectTypeOf<keyof PersistenceClient['outgoing']>().toEqualTypeOf<
      'remove-member' | 'kick-member' | 'ban' | 'server-drop'
    >();
  });
});

describe('PersistenceClient — channels', () => {
  it('addressing: archive-room and typing-indicator are static channels', () => {
    expectTypeOf<
      PersistenceClient['channels']['archive-room']['addressing']
    >().toEqualTypeOf<'static'>();
    expectTypeOf<
      PersistenceClient['channels']['typing-indicator']['addressing']
    >().toEqualTypeOf<'static'>();
  });

  it('has archive-room channel', () => {
    expectTypeOf<PersistenceClient['channels']>().toHaveProperty('archive-room');
  });

  it('has typing-indicator channel', () => {
    expectTypeOf<PersistenceClient['channels']>().toHaveProperty('typing-indicator');
  });

  it('archive-room incoming has room-message', () => {
    expectTypeOf<
      PersistenceClient['channels']['archive-room']['incoming']['room-message']
    >().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('archive-room incoming has session-ended', () => {
    expectTypeOf<
      PersistenceClient['channels']['archive-room']['incoming']['session-ended']
    >().toEqualTypeOf<{
      channel: string;
      username: string;
    }>();
  });

  it('archive-room outgoing has send-message (server incoming)', () => {
    expectTypeOf<
      PersistenceClient['channels']['archive-room']['outgoing']['send-message']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('typing-indicator incoming has room-message', () => {
    expectTypeOf<
      PersistenceClient['channels']['typing-indicator']['incoming']['room-message']
    >().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('typing-indicator outgoing is empty', () => {
    expectTypeOf<keyof PersistenceClient['channels']['typing-indicator']['outgoing']>().toBeNever();
  });
});

describe('PersistenceClient — empty slots', () => {
  it('exposes the exec-counter clientRequests', () => {
    expectTypeOf<keyof PersistenceClient['clientRequests']>().toEqualTypeOf<
      'record-exec' | 'read-exec-count'
    >();
  });

  it('exposes only the anon-stream resumable stream', () => {
    expectTypeOf<keyof PersistenceClient['streams']>().toEqualTypeOf<'anon-stream'>();
  });
});

describe('PersistenceClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<PersistenceClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<PersistenceClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<PersistenceClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<PersistenceClient['errors']>().toHaveProperty('internal-error');
  });
});
