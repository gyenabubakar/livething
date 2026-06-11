import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelCheckCommitClient } from './handler.ts';

describe('ChannelCheckCommitClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ChannelCheckCommitClient['incoming']>().not.toBeAny();
    expectTypeOf<ChannelCheckCommitClient['outgoing']>().not.toBeAny();
    expectTypeOf<ChannelCheckCommitClient['channels']>().not.toBeAny();
    expectTypeOf<ChannelCheckCommitClient['errors']>().not.toBeAny();
  });
});

describe('ChannelCheckCommitClient — channel shape', () => {
  it('addressing: room, check-only, commit-only and nonce-room are static channels', () => {
    expectTypeOf<
      ChannelCheckCommitClient['channels']['room']['addressing']
    >().toEqualTypeOf<'static'>();
    expectTypeOf<
      ChannelCheckCommitClient['channels']['check-only']['addressing']
    >().toEqualTypeOf<'static'>();
    expectTypeOf<
      ChannelCheckCommitClient['channels']['commit-only']['addressing']
    >().toEqualTypeOf<'static'>();
    expectTypeOf<
      ChannelCheckCommitClient['channels']['nonce-room']['addressing']
    >().toEqualTypeOf<'static'>();
  });

  it('nonce-room exposes subscribePayload from its check validator', () => {
    expectTypeOf<
      ChannelCheckCommitClient['channels']['nonce-room']['subscribePayload']
    >().toEqualTypeOf<{ token: string }>();
  });

  it('server-drop is a client-sendable (top-level outgoing) event', () => {
    expectTypeOf<ChannelCheckCommitClient['outgoing']>().toHaveProperty('server-drop');
  });

  it('has room channel', () => {
    expectTypeOf<ChannelCheckCommitClient['channels']>().toHaveProperty('room');
  });

  it('has check-only channel', () => {
    expectTypeOf<ChannelCheckCommitClient['channels']>().toHaveProperty('check-only');
  });

  it('has commit-only channel', () => {
    expectTypeOf<ChannelCheckCommitClient['channels']>().toHaveProperty('commit-only');
  });

  it('room channel exposes subscribePayload matching the check validator', () => {
    expectTypeOf<ChannelCheckCommitClient['channels']['room']['subscribePayload']>().toEqualTypeOf<{
      token: string;
    }>();
  });

  it('check-only channel has no subscribePayload (no check validator)', () => {
    expectTypeOf<ChannelCheckCommitClient['channels']['check-only']>().not.toHaveProperty(
      'subscribePayload',
    );
  });

  it('commit-only channel has no subscribePayload', () => {
    expectTypeOf<ChannelCheckCommitClient['channels']['commit-only']>().not.toHaveProperty(
      'subscribePayload',
    );
  });

  it('room channel incoming has joined (server outgoing)', () => {
    expectTypeOf<
      ChannelCheckCommitClient['channels']['room']['incoming']['joined']
    >().toEqualTypeOf<{ username: string }>();
  });

  it('room channel incoming has message (server outgoing)', () => {
    expectTypeOf<
      ChannelCheckCommitClient['channels']['room']['incoming']['message']
    >().toEqualTypeOf<{ from: string; text: string }>();
  });

  it('room channel outgoing has send (server incoming)', () => {
    expectTypeOf<ChannelCheckCommitClient['channels']['room']['outgoing']['send']>().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('ChannelCheckCommitClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ChannelCheckCommitClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ChannelCheckCommitClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ChannelCheckCommitClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ChannelCheckCommitClient['errors']>().toHaveProperty('internal-error');
  });
});
