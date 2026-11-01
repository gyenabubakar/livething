import { describe, expectTypeOf, it } from 'vitest';
import type { ChannelStaticClient } from './handler.ts';

describe('ChannelStaticClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ChannelStaticClient['incoming']>().not.toBeAny();
    expectTypeOf<ChannelStaticClient['outgoing']>().not.toBeAny();
    expectTypeOf<ChannelStaticClient['clientRequests']>().not.toBeAny();
    expectTypeOf<ChannelStaticClient['streams']>().not.toBeAny();
    expectTypeOf<ChannelStaticClient['channels']>().not.toBeAny();

    expectTypeOf<ChannelStaticClient['errors']>().not.toBeAny();
  });
});

describe('ChannelStaticClient — top-level incoming (server outgoing)', () => {
  it('has tag-ack', () => {
    expectTypeOf<ChannelStaticClient['incoming']['tag-ack']>().toEqualTypeOf<{ tag: string }>();
  });

  it('has kick-ack', () => {
    expectTypeOf<ChannelStaticClient['incoming']['kick-ack']>().toEqualTypeOf<{ tag: string }>();
  });

  it('has kick-failed', () => {
    expectTypeOf<ChannelStaticClient['incoming']['kick-failed']>().toEqualTypeOf<{
      tag: string;
      failures: number;
    }>();
  });

  it('exactly three events in top-level incoming', () => {
    expectTypeOf<keyof ChannelStaticClient['incoming']>().toEqualTypeOf<
      'tag-ack' | 'kick-ack' | 'kick-failed'
    >();
  });
});

describe('ChannelStaticClient — top-level outgoing (server incoming)', () => {
  it('has tag-self', () => {
    expectTypeOf<ChannelStaticClient['outgoing']['tag-self']>().toEqualTypeOf<{ tag: string }>();
  });

  it('has kick-by-tag', () => {
    expectTypeOf<ChannelStaticClient['outgoing']['kick-by-tag']>().toEqualTypeOf<{
      tag: string;
      reason: string;
    }>();
  });

  it('has trigger-server-subscribe with empty payload', () => {
    expectTypeOf<ChannelStaticClient['outgoing']['trigger-server-subscribe']>().toEqualTypeOf<{}>();
  });

  it('exactly three events in top-level outgoing', () => {
    expectTypeOf<keyof ChannelStaticClient['outgoing']>().toEqualTypeOf<
      'tag-self' | 'kick-by-tag' | 'trigger-server-subscribe'
    >();
  });
});

describe('ChannelStaticClient — channels', () => {
  it('addressing: room and room2 are static channels', () => {
    expectTypeOf<ChannelStaticClient['channels']['room']['addressing']>().toEqualTypeOf<'static'>();
    expectTypeOf<
      ChannelStaticClient['channels']['room2']['addressing']
    >().toEqualTypeOf<'static'>();
  });

  it('has room channel', () => {
    expectTypeOf<ChannelStaticClient['channels']>().toHaveProperty('room');
  });

  it('has room2 channel', () => {
    expectTypeOf<ChannelStaticClient['channels']>().toHaveProperty('room2');
  });

  it('room channel incoming has room-message (server outgoing)', () => {
    expectTypeOf<
      ChannelStaticClient['channels']['room']['incoming']['room-message']
    >().toEqualTypeOf<{
      text: string;
      from: string;
      kind: string;
    }>();
  });

  it('room channel outgoing has send-message (server incoming)', () => {
    expectTypeOf<
      ChannelStaticClient['channels']['room']['outgoing']['send-message']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('room channel outgoing has trigger-bad-broadcast', () => {
    expectTypeOf<
      ChannelStaticClient['channels']['room']['outgoing']['trigger-bad-broadcast']
    >().toEqualTypeOf<{}>();
  });

  it('room channel streams has start-channel-stream', () => {
    expectTypeOf<ChannelStaticClient['channels']['room']['streams']>().toHaveProperty(
      'start-channel-stream',
    );
  });

  it('start-channel-stream has correct payload and chunk types', () => {
    expectTypeOf<
      ChannelStaticClient['channels']['room']['streams']['start-channel-stream']['payload']
    >().toEqualTypeOf<{ count: number }>();
    expectTypeOf<
      ChannelStaticClient['channels']['room']['streams']['start-channel-stream']['chunk']
    >().toEqualTypeOf<{
      index: number;
    }>();
  });

  it('start-channel-stream has no nudges (basic stream)', () => {
    expectTypeOf<
      ChannelStaticClient['channels']['room']['streams']['start-channel-stream']
    >().not.toHaveProperty('nudges');
    expectTypeOf<
      ChannelStaticClient['channels']['room']['streams']['start-channel-stream']
    >().not.toHaveProperty('broadcast');
  });

  it('room2 channel has room-message in incoming', () => {
    expectTypeOf<
      ChannelStaticClient['channels']['room2']['incoming']['room-message']
    >().toEqualTypeOf<{
      text: string;
      from: string;
      kind: string;
    }>();
  });
});

describe('ChannelStaticClient — empty slots', () => {
  it('clientRequests is empty', () => {
    expectTypeOf<keyof ChannelStaticClient['clientRequests']>().toBeNever();
  });

  it('top-level streams is empty', () => {
    expectTypeOf<keyof ChannelStaticClient['streams']>().toBeNever();
  });
});

describe('ChannelStaticClient — stream kind', () => {
  it('start-channel-stream is ephemeral', () => {
    expectTypeOf<
      ChannelStaticClient['channels']['room']['streams']['start-channel-stream']['kind']
    >().toEqualTypeOf<'ephemeral'>();
  });
});

describe('ChannelStaticClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ChannelStaticClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ChannelStaticClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ChannelStaticClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ChannelStaticClient['errors']>().toHaveProperty('internal-error');
  });
});
