import { describe, expectTypeOf, it } from 'vitest';
import type { ReplaySnapshotClient } from './handler.ts';

describe('ReplaySnapshotClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ReplaySnapshotClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplaySnapshotClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplaySnapshotClient['requests']>().not.toBeAny();
    expectTypeOf<ReplaySnapshotClient['streams']>().not.toBeAny();
    expectTypeOf<ReplaySnapshotClient['channels']>().not.toBeAny();
    expectTypeOf<ReplaySnapshotClient['errors']>().not.toBeAny();
  });
});

describe('ReplaySnapshotClient — incoming (server outgoing)', () => {
  it('has doc-snapshot', () => {
    expectTypeOf<ReplaySnapshotClient['incoming']['doc-snapshot']>().toEqualTypeOf<{
      docId: string;
      title: string;
    }>();
  });

  it('has doc-deleted', () => {
    expectTypeOf<ReplaySnapshotClient['incoming']['doc-deleted']>().toEqualTypeOf<{
      docId: string;
    }>();
  });

  it('has counter-snapshot', () => {
    expectTypeOf<ReplaySnapshotClient['incoming']['counter-snapshot']>().toEqualTypeOf<{
      key: string;
      total: number;
    }>();
  });

  it('has burst-done', () => {
    expectTypeOf<ReplaySnapshotClient['incoming']['burst-done']>().toEqualTypeOf<{
      key: string;
      sent: number;
    }>();
  });

  it('exactly four events in top-level incoming', () => {
    expectTypeOf<keyof ReplaySnapshotClient['incoming']>().toEqualTypeOf<
      'doc-snapshot' | 'doc-deleted' | 'counter-snapshot' | 'burst-done'
    >();
  });
});

describe('ReplaySnapshotClient — outgoing (server incoming)', () => {
  it('has update-doc', () => {
    expectTypeOf<ReplaySnapshotClient['outgoing']['update-doc']>().toEqualTypeOf<{
      docId: string;
      title: string;
    }>();
  });

  it('has delete-doc', () => {
    expectTypeOf<ReplaySnapshotClient['outgoing']['delete-doc']>().toEqualTypeOf<{
      docId: string;
    }>();
  });

  it('has increment-counter', () => {
    expectTypeOf<ReplaySnapshotClient['outgoing']['increment-counter']>().toEqualTypeOf<{
      key: string;
      amount: number;
    }>();
  });

  it('has burst-counter', () => {
    expectTypeOf<ReplaySnapshotClient['outgoing']['burst-counter']>().toEqualTypeOf<{
      key: string;
      count: number;
    }>();
  });
});

describe('ReplaySnapshotClient — channels', () => {
  it('addressing: snapshot-room is a static channel', () => {
    expectTypeOf<
      ReplaySnapshotClient['channels']['snapshot-room']['addressing']
    >().toEqualTypeOf<'static'>();
  });

  it('has snapshot-room channel', () => {
    expectTypeOf<ReplaySnapshotClient['channels']>().toHaveProperty('snapshot-room');
  });

  it('snapshot-room incoming has room-doc-snapshot (server outgoing)', () => {
    expectTypeOf<
      ReplaySnapshotClient['channels']['snapshot-room']['incoming']['room-doc-snapshot']
    >().toEqualTypeOf<{
      docId: string;
      title: string;
    }>();
  });

  it('snapshot-room outgoing has update-room-doc (server incoming)', () => {
    expectTypeOf<
      ReplaySnapshotClient['channels']['snapshot-room']['outgoing']['update-room-doc']
    >().toEqualTypeOf<{
      docId: string;
      title: string;
    }>();
  });
});

describe('ReplaySnapshotClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof ReplaySnapshotClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ReplaySnapshotClient['streams']>().toBeNever();
  });
});

describe('ReplaySnapshotClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ReplaySnapshotClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ReplaySnapshotClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ReplaySnapshotClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ReplaySnapshotClient['errors']>().toHaveProperty('internal-error');
  });
});
