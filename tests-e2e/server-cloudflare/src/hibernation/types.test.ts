import { describe, expectTypeOf, it } from 'vitest';
import type { HibernationClient } from './handler.ts';

describe('HibernationClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<HibernationClient['incoming']>().not.toBeAny();
    expectTypeOf<HibernationClient['outgoing']>().not.toBeAny();
    expectTypeOf<HibernationClient['clientRequests']>().not.toBeAny();
    expectTypeOf<HibernationClient['streams']>().not.toBeAny();
    expectTypeOf<HibernationClient['channels']>().not.toBeAny();

    expectTypeOf<HibernationClient['errors']>().not.toBeAny();
  });
});

describe('HibernationClient — incoming (server outgoing)', () => {
  it('has notes-list', () => {
    expectTypeOf<HibernationClient['incoming']['notes-list']>().toEqualTypeOf<{
      notes: Array<{ title: string; body: string }>;
    }>();
  });

  it('has tag-result', () => {
    expectTypeOf<HibernationClient['incoming']['tag-result']>().toEqualTypeOf<{
      tags: string[];
    }>();
  });

  it('has tagged-message', () => {
    expectTypeOf<HibernationClient['incoming']['tagged-message']>().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('has room-members-count', () => {
    expectTypeOf<HibernationClient['incoming']['room-members-count']>().toEqualTypeOf<{
      count: number;
    }>();
  });

  it('has conn-info', () => {
    expectTypeOf<HibernationClient['incoming']['conn-info']>().toEqualTypeOf<{
      quality: 'excellent' | 'good' | 'degraded' | 'poor' | null;
      latency: number | null;
    }>();
  });

  it('exactly five events in top-level incoming', () => {
    expectTypeOf<keyof HibernationClient['incoming']>().toEqualTypeOf<
      'notes-list' | 'tag-result' | 'tagged-message' | 'room-members-count' | 'conn-info'
    >();
  });
});

describe('HibernationClient — outgoing (server incoming)', () => {
  it('has save-note', () => {
    expectTypeOf<HibernationClient['outgoing']['save-note']>().toEqualTypeOf<{
      title: string;
      body: string;
    }>();
  });

  it('has get-notes with empty payload', () => {
    expectTypeOf<HibernationClient['outgoing']['get-notes']>().toEqualTypeOf<{}>();
  });

  it('has tag-self', () => {
    expectTypeOf<HibernationClient['outgoing']['tag-self']>().toEqualTypeOf<{ tag: string }>();
  });

  it('has send-to-tag', () => {
    expectTypeOf<HibernationClient['outgoing']['send-to-tag']>().toEqualTypeOf<{
      tag: string;
      text: string;
    }>();
  });

  it('has get-room-members with empty payload', () => {
    expectTypeOf<HibernationClient['outgoing']['get-room-members']>().toEqualTypeOf<{}>();
  });

  it('has probe-conn with empty payload', () => {
    expectTypeOf<HibernationClient['outgoing']['probe-conn']>().toEqualTypeOf<{}>();
  });
});

describe('HibernationClient — streams', () => {
  it('has start-slow-stream', () => {
    expectTypeOf<HibernationClient['streams']>().toHaveProperty('start-slow-stream');
  });

  it('start-slow-stream has correct payload and chunk', () => {
    expectTypeOf<
      HibernationClient['streams']['start-slow-stream']['payload']
    >().toEqualTypeOf<{}>();
    expectTypeOf<HibernationClient['streams']['start-slow-stream']['chunk']>().toEqualTypeOf<{
      index: number;
    }>();
  });

  it('start-slow-stream has no nudges', () => {
    expectTypeOf<HibernationClient['streams']['start-slow-stream']>().not.toHaveProperty('nudges');
    expectTypeOf<HibernationClient['streams']['start-slow-stream']>().not.toHaveProperty(
      'broadcast',
    );
  });
});

describe('HibernationClient — stream kind', () => {
  it('start-slow-stream is ephemeral', () => {
    expectTypeOf<
      HibernationClient['streams']['start-slow-stream']['kind']
    >().toEqualTypeOf<'ephemeral'>();
  });
});

describe('HibernationClient — channels', () => {
  it('has room channel', () => {
    expectTypeOf<HibernationClient['channels']>().toHaveProperty('room');
  });

  it('room incoming has room-message (server outgoing)', () => {
    expectTypeOf<
      HibernationClient['channels']['room']['incoming']['room-message']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('room outgoing has broadcast-to-room (server incoming)', () => {
    expectTypeOf<
      HibernationClient['channels']['room']['outgoing']['broadcast-to-room']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('HibernationClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<HibernationClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<HibernationClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<HibernationClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<HibernationClient['errors']>().toHaveProperty('internal-error');
  });
});
