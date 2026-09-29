import { describe, expectTypeOf, it } from 'vitest';
import type { StreamDurableBroadcastClient } from './handler.ts';

describe('StreamDurableBroadcastClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<StreamDurableBroadcastClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamDurableBroadcastClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamDurableBroadcastClient['clientRequests']>().not.toBeAny();
    expectTypeOf<StreamDurableBroadcastClient['streams']>().not.toBeAny();
    expectTypeOf<StreamDurableBroadcastClient['channels']>().not.toBeAny();

    expectTypeOf<StreamDurableBroadcastClient['errors']>().not.toBeAny();
  });
});

describe('StreamDurableBroadcastClient — channels', () => {
  it('addressing: rooms is a static channel', () => {
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['addressing']
    >().toEqualTypeOf<'static'>();
  });

  it('has rooms channel', () => {
    expectTypeOf<StreamDurableBroadcastClient['channels']>().toHaveProperty('rooms');
  });

  it('rooms streams has feed (recordedStream)', () => {
    expectTypeOf<StreamDurableBroadcastClient['channels']['rooms']['streams']>().toHaveProperty(
      'feed',
    );
  });

  it('feed has correct payload and chunk', () => {
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['streams']['feed']['payload']
    >().toEqualTypeOf<{}>();
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['streams']['feed']['chunk']
    >().toEqualTypeOf<{
      token: string;
    }>();
  });

  it('feed has no cursor, nudges, or broadcast key', () => {
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['streams']['feed']
    >().not.toHaveProperty('cursor');
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['streams']['feed']
    >().not.toHaveProperty('nudges');
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['streams']['feed']
    >().not.toHaveProperty('broadcast');
  });

  it('rooms streams has paginate (cursorStream)', () => {
    expectTypeOf<StreamDurableBroadcastClient['channels']['rooms']['streams']>().toHaveProperty(
      'paginate',
    );
  });

  it('paginate has correct chunk', () => {
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['streams']['paginate']['chunk']
    >().toEqualTypeOf<{
      row: number;
    }>();
  });

  it('paginate has no cursor (no cursor validator)', () => {
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['streams']['paginate']
    >().not.toHaveProperty('cursor');
  });

  it('rooms streams has attempt-broadcast (cursorStream)', () => {
    expectTypeOf<StreamDurableBroadcastClient['channels']['rooms']['streams']>().toHaveProperty(
      'attempt-broadcast',
    );
  });

  it('attempt-broadcast chunk is correct', () => {
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['streams']['attempt-broadcast']['chunk']
    >().toEqualTypeOf<{ attempt: number }>();
  });

  it('rooms incoming and outgoing are empty', () => {
    expectTypeOf<keyof StreamDurableBroadcastClient['channels']['rooms']['incoming']>().toBeNever();
    expectTypeOf<keyof StreamDurableBroadcastClient['channels']['rooms']['outgoing']>().toBeNever();
  });
});

describe('StreamDurableBroadcastClient — stream kind', () => {
  it('all streams are persistent', () => {
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['streams']['attempt-broadcast']['kind']
    >().toEqualTypeOf<'persistent'>();
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['streams']['paginate']['kind']
    >().toEqualTypeOf<'persistent'>();
    expectTypeOf<
      StreamDurableBroadcastClient['channels']['rooms']['streams']['feed']['kind']
    >().toEqualTypeOf<'persistent'>();
  });
});

describe('StreamDurableBroadcastClient — empty slots', () => {
  it('top-level incoming is empty', () => {
    expectTypeOf<keyof StreamDurableBroadcastClient['incoming']>().toBeNever();
  });

  it('top-level outgoing is empty', () => {
    expectTypeOf<keyof StreamDurableBroadcastClient['outgoing']>().toBeNever();
  });

  it('clientRequests is empty', () => {
    expectTypeOf<keyof StreamDurableBroadcastClient['clientRequests']>().toBeNever();
  });

  it('top-level streams is empty', () => {
    expectTypeOf<keyof StreamDurableBroadcastClient['streams']>().toBeNever();
  });
});

describe('StreamDurableBroadcastClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<StreamDurableBroadcastClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<StreamDurableBroadcastClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<StreamDurableBroadcastClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<StreamDurableBroadcastClient['errors']>().toHaveProperty('internal-error');
  });
});
