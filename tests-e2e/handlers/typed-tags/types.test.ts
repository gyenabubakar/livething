import { describe, expectTypeOf, it } from 'vitest';
import type { TypedTagsClient } from './handler.ts';

describe('TypedTagsClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<TypedTagsClient['incoming']>().not.toBeAny();
    expectTypeOf<TypedTagsClient['outgoing']>().not.toBeAny();
    expectTypeOf<TypedTagsClient['clientRequests']>().not.toBeAny();
    expectTypeOf<TypedTagsClient['streams']>().not.toBeAny();
    expectTypeOf<TypedTagsClient['channels']>().not.toBeAny();
    expectTypeOf<TypedTagsClient['errors']>().not.toBeAny();
  });
});

describe('TypedTagsClient — incoming (server outgoing)', () => {
  it('has tags-list', () => {
    expectTypeOf<TypedTagsClient['incoming']['tags-list']>().toEqualTypeOf<{
      tags: Array<{ kind: string; group: string; key: string }>;
    }>();
  });

  it('has fan-out-echo', () => {
    expectTypeOf<TypedTagsClient['incoming']['fan-out-echo']>().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('has count-result', () => {
    expectTypeOf<TypedTagsClient['incoming']['count-result']>().toEqualTypeOf<{ count: number }>();
  });

  it('has group-stats-result', () => {
    expectTypeOf<TypedTagsClient['incoming']['group-stats-result']>().toEqualTypeOf<{
      has: boolean;
      keys: string[];
      connections: number;
      count: number;
    }>();
  });

  it('exactly four events in incoming', () => {
    expectTypeOf<keyof TypedTagsClient['incoming']>().toEqualTypeOf<
      'tags-list' | 'fan-out-echo' | 'count-result' | 'group-stats-result'
    >();
  });
});

describe('TypedTagsClient — outgoing (server incoming)', () => {
  it('has add-tag', () => {
    expectTypeOf<TypedTagsClient['outgoing']['add-tag']>().toEqualTypeOf<{
      kind: 'ephemeral' | 'persistent';
      group: string;
      key: string;
    }>();
  });

  it('has remove-tag', () => {
    expectTypeOf<TypedTagsClient['outgoing']['remove-tag']>().toEqualTypeOf<{
      kind: 'ephemeral' | 'persistent';
      group: string;
      key: string;
    }>();
  });

  it('has list-my-tags with empty payload', () => {
    expectTypeOf<TypedTagsClient['outgoing']['list-my-tags']>().toEqualTypeOf<{}>();
  });

  it('has fan-out-to-tag', () => {
    expectTypeOf<TypedTagsClient['outgoing']['fan-out-to-tag']>().toEqualTypeOf<{
      group: string;
      key: string;
      text: string;
    }>();
  });

  it('has count-by-tag', () => {
    expectTypeOf<TypedTagsClient['outgoing']['count-by-tag']>().toEqualTypeOf<{
      group: string;
      key: string;
    }>();
  });

  it('has kick-by-tag', () => {
    expectTypeOf<TypedTagsClient['outgoing']['kick-by-tag']>().toEqualTypeOf<{
      group: string;
      key: string;
      reason: string;
    }>();
  });

  it('has group-stats', () => {
    expectTypeOf<TypedTagsClient['outgoing']['group-stats']>().toEqualTypeOf<{ key: string }>();
  });

  it('exactly seven events in outgoing', () => {
    expectTypeOf<keyof TypedTagsClient['outgoing']>().toEqualTypeOf<
      | 'add-tag'
      | 'remove-tag'
      | 'list-my-tags'
      | 'fan-out-to-tag'
      | 'count-by-tag'
      | 'kick-by-tag'
      | 'group-stats'
    >();
  });
});

describe('TypedTagsClient — channels', () => {
  it('addressing: room is a static channel', () => {
    expectTypeOf<TypedTagsClient['channels']['room']['addressing']>().toEqualTypeOf<'static'>();
  });

  it('has room channel', () => {
    expectTypeOf<TypedTagsClient['channels']>().toHaveProperty('room');
  });

  it('room incoming has room-message (server outgoing)', () => {
    expectTypeOf<TypedTagsClient['channels']['room']['incoming']['room-message']>().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('room outgoing has send-in-room (server incoming)', () => {
    expectTypeOf<TypedTagsClient['channels']['room']['outgoing']['send-in-room']>().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('TypedTagsClient — empty slots', () => {
  it('clientRequests is empty', () => {
    expectTypeOf<keyof TypedTagsClient['clientRequests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof TypedTagsClient['streams']>().toBeNever();
  });
});

describe('TypedTagsClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<TypedTagsClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<TypedTagsClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<TypedTagsClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<TypedTagsClient['errors']>().toHaveProperty('internal-error');
  });
});
