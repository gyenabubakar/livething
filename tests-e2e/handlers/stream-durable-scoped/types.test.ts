import { describe, expectTypeOf, it } from 'vitest';
import type { StreamDurableScopedClient } from './handler.ts';

describe('StreamDurableScopedClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<StreamDurableScopedClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamDurableScopedClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamDurableScopedClient['requests']>().not.toBeAny();
    expectTypeOf<StreamDurableScopedClient['streams']>().not.toBeAny();
    expectTypeOf<StreamDurableScopedClient['channels']>().not.toBeAny();
    expectTypeOf<StreamDurableScopedClient['errors']>().not.toBeAny();
  });
});

describe('StreamDurableScopedClient — top-level streams', () => {
  it('has start-concurrent (basic stream)', () => {
    expectTypeOf<StreamDurableScopedClient['streams']>().toHaveProperty('start-concurrent');
  });

  it('start-concurrent has correct payload and chunk', () => {
    expectTypeOf<
      StreamDurableScopedClient['streams']['start-concurrent']['payload']
    >().toEqualTypeOf<{}>();
    expectTypeOf<
      StreamDurableScopedClient['streams']['start-concurrent']['chunk']
    >().toEqualTypeOf<{
      token: string;
    }>();
  });

  it('start-concurrent has no cursor or nudges', () => {
    expectTypeOf<StreamDurableScopedClient['streams']['start-concurrent']>().not.toHaveProperty(
      'cursor',
    );
    expectTypeOf<StreamDurableScopedClient['streams']['start-concurrent']>().not.toHaveProperty(
      'nudges',
    );
  });

  it('has boom-mid (recordedStream)', () => {
    expectTypeOf<StreamDurableScopedClient['streams']>().toHaveProperty('boom-mid');
  });

  it('boom-mid chunk is correct', () => {
    expectTypeOf<StreamDurableScopedClient['streams']['boom-mid']['chunk']>().toEqualTypeOf<{
      idx: number;
    }>();
  });

  it('has short-window (resumableStream — no cursor validator)', () => {
    expectTypeOf<StreamDurableScopedClient['streams']>().toHaveProperty('short-window');
  });

  it('short-window has correct chunk', () => {
    expectTypeOf<StreamDurableScopedClient['streams']['short-window']['chunk']>().toEqualTypeOf<{
      row: number;
    }>();
  });

  it('short-window has no cursor (no cursor validator declared)', () => {
    expectTypeOf<StreamDurableScopedClient['streams']['short-window']>().not.toHaveProperty(
      'cursor',
    );
  });

  it('has short-retention (recordedStream)', () => {
    expectTypeOf<StreamDurableScopedClient['streams']>().toHaveProperty('short-retention');
  });

  it('has keep-running-feed (recordedStream)', () => {
    expectTypeOf<StreamDurableScopedClient['streams']>().toHaveProperty('keep-running-feed');
  });
});

describe('StreamDurableScopedClient — channels.rooms streams', () => {
  it('addressing: rooms is a static channel', () => {
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['addressing']
    >().toEqualTypeOf<'static'>();
  });

  it('rooms has paginate (resumableStream — no cursor)', () => {
    expectTypeOf<StreamDurableScopedClient['channels']['rooms']['streams']>().toHaveProperty(
      'paginate',
    );
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['paginate']
    >().not.toHaveProperty('cursor');
  });

  it('rooms has history (recordedStream)', () => {
    expectTypeOf<StreamDurableScopedClient['channels']['rooms']['streams']>().toHaveProperty(
      'history',
    );
  });

  it('history chunk is correct', () => {
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['history']['chunk']
    >().toEqualTypeOf<{
      idx: number;
    }>();
  });

  it('rooms has paused-feed (resumableStream with nudges)', () => {
    expectTypeOf<StreamDurableScopedClient['channels']['rooms']['streams']>().toHaveProperty(
      'paused-feed',
    );
  });

  it('paused-feed has nudges (nudge declared)', () => {
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['paused-feed']
    >().toHaveProperty('nudges');
  });

  it('paused-feed has no cursor (no cursor validator declared)', () => {
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['paused-feed']
    >().not.toHaveProperty('cursor');
  });

  it('rooms has channel-tokens (basic stream with nudges)', () => {
    expectTypeOf<StreamDurableScopedClient['channels']['rooms']['streams']>().toHaveProperty(
      'channel-tokens',
    );
  });

  it('channel-tokens has nudges', () => {
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['channel-tokens']
    >().toHaveProperty('nudges');
  });

  it('channel-tokens has no cursor (basic stream)', () => {
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['channel-tokens']
    >().not.toHaveProperty('cursor');
  });

  it('rooms has history-nudged (recordedStream with nudges)', () => {
    expectTypeOf<StreamDurableScopedClient['channels']['rooms']['streams']>().toHaveProperty(
      'history-nudged',
    );
  });

  it('history-nudged has nudges', () => {
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['history-nudged']
    >().toHaveProperty('nudges');
  });

  it('no channel stream has a broadcast key', () => {
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['paginate']
    >().not.toHaveProperty('broadcast');
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['history']
    >().not.toHaveProperty('broadcast');
  });
});

describe('StreamDurableScopedClient — stream kind', () => {
  it('top-level streams have correct resumable flags', () => {
    expectTypeOf<
      StreamDurableScopedClient['streams']['start-concurrent']['kind']
    >().toEqualTypeOf<'ephemeral'>();
    expectTypeOf<
      StreamDurableScopedClient['streams']['boom-mid']['kind']
    >().toEqualTypeOf<'persistent'>();
    expectTypeOf<
      StreamDurableScopedClient['streams']['short-window']['kind']
    >().toEqualTypeOf<'persistent'>();
    expectTypeOf<
      StreamDurableScopedClient['streams']['short-retention']['kind']
    >().toEqualTypeOf<'persistent'>();
    expectTypeOf<
      StreamDurableScopedClient['streams']['keep-running-feed']['kind']
    >().toEqualTypeOf<'persistent'>();
  });

  it('channel streams have correct resumable flags', () => {
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['channel-tokens']['kind']
    >().toEqualTypeOf<'ephemeral'>();
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['paginate']['kind']
    >().toEqualTypeOf<'persistent'>();
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['paused-feed']['kind']
    >().toEqualTypeOf<'persistent'>();
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['history']['kind']
    >().toEqualTypeOf<'persistent'>();
    expectTypeOf<
      StreamDurableScopedClient['channels']['rooms']['streams']['history-nudged']['kind']
    >().toEqualTypeOf<'persistent'>();
  });
});

describe('StreamDurableScopedClient — empty slots', () => {
  it('incoming is empty', () => {
    expectTypeOf<keyof StreamDurableScopedClient['incoming']>().toBeNever();
  });

  it('outgoing is empty', () => {
    expectTypeOf<keyof StreamDurableScopedClient['outgoing']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof StreamDurableScopedClient['requests']>().toBeNever();
  });
});

describe('StreamDurableScopedClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<StreamDurableScopedClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<StreamDurableScopedClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<StreamDurableScopedClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<StreamDurableScopedClient['errors']>().toHaveProperty('internal-error');
  });
});
