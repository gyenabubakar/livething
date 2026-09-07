import { describe, expectTypeOf, it } from 'vitest';
import type { MultifileClient } from './handler.ts';

describe('MultifileClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<MultifileClient['incoming']>().not.toBeAny();
    expectTypeOf<MultifileClient['outgoing']>().not.toBeAny();
    expectTypeOf<MultifileClient['clientRequests']>().not.toBeAny();
    expectTypeOf<MultifileClient['streams']>().not.toBeAny();
    expectTypeOf<MultifileClient['channels']>().not.toBeAny();

    expectTypeOf<MultifileClient['errors']>().not.toBeAny();
  });
});

describe('MultifileClient — incoming (server outgoing)', () => {
  it('has notification', () => {
    expectTypeOf<MultifileClient['incoming']['notification']>().toEqualTypeOf<{ title: string }>();
  });

  it('only notification in top-level incoming', () => {
    expectTypeOf<keyof MultifileClient['incoming']>().toEqualTypeOf<'notification'>();
  });
});

describe('MultifileClient — outgoing is empty (no top-level server incoming)', () => {
  it('outgoing is empty', () => {
    expectTypeOf<keyof MultifileClient['outgoing']>().toBeNever();
  });
});

describe('MultifileClient — channels', () => {
  it('addressing: lobby is a static channel', () => {
    expectTypeOf<MultifileClient['channels']['lobby']['addressing']>().toEqualTypeOf<'static'>();
  });

  it('has lobby channel', () => {
    expectTypeOf<MultifileClient['channels']>().toHaveProperty('lobby');
  });

  it('lobby incoming has room-message (server outgoing)', () => {
    expectTypeOf<MultifileClient['channels']['lobby']['incoming']['room-message']>().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('lobby outgoing has send-room-message (server incoming)', () => {
    expectTypeOf<
      MultifileClient['channels']['lobby']['outgoing']['send-room-message']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('MultifileClient — empty slots', () => {
  it('clientRequests is empty', () => {
    expectTypeOf<keyof MultifileClient['clientRequests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof MultifileClient['streams']>().toBeNever();
  });
});

describe('MultifileClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<MultifileClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<MultifileClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<MultifileClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<MultifileClient['errors']>().toHaveProperty('internal-error');
  });
});
