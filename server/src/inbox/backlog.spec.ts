import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type { LastSeenService } from '~/_engine/runtime/feature-slots.ts';
import { advanceReceivedThrough, ensureReceiptsSchema } from './receipts-storage.ts';
import { ackInboxRows, ensureInboxSchema, insertInboxRows } from './storage.ts';
import { buildInboxSurface } from './surface.ts';

const SCOPE = { channelName: 'room', channelFamily: null } as const;

function seedRow(
  sql: ReturnType<typeof createTestSql>,
  row: { identity: string; seq: number; createdAt: number },
) {
  insertInboxRows(sql, {
    identities: [row.identity],
    channelName: SCOPE.channelName,
    channelFamily: SCOPE.channelFamily,
    frame: { seq: row.seq, messageId: `m${row.seq}-${row.identity}`, event: 'msg', payload: {} },
    now: row.createdAt,
  });
}

function harness(opts: { online?: Set<string>; lastSeen?: LastSeenService } = {}) {
  const sql = createTestSql();
  ensureInboxSchema(sql);
  ensureReceiptsSchema(sql);

  const engine = {
    requireStorage: () => ({ sql }),
    isIdentityOnline: (identity: string) => opts.online?.has(identity) ?? false,
    getLastSeenService: () => opts.lastSeen,
  } as unknown as EngineAccess;

  return { sql, surface: buildInboxSurface(engine, SCOPE) };
}

describe('inbox backlog()', () => {
  it('reports one entry per member with held unacked rows and the received cursor', () => {
    const { sql, surface } = harness({ online: new Set(['alice']) });

    seedRow(sql, { identity: 'alice', seq: 1, createdAt: 100 });
    seedRow(sql, { identity: 'alice', seq: 2, createdAt: 200 });
    seedRow(sql, { identity: 'bob', seq: 3, createdAt: 300 });

    advanceReceivedThrough(sql, {
      channelName: SCOPE.channelName,
      channelFamily: SCOPE.channelFamily,
      identity: 'alice',
      receivedThrough: 4,
      now: 1,
    });

    const backlog = surface.backlog();

    expect(backlog).toHaveLength(2);
    const alice = backlog.find((e) => e.identity === 'alice')!;
    const bob = backlog.find((e) => e.identity === 'bob')!;

    expect(alice).toMatchObject({
      identity: 'alice',
      online: true,
      heldRows: 2,
      receivedThrough: 4,
      oldestHeldAt: 100,
    });
    expect(bob).toMatchObject({
      identity: 'bob',
      online: false,
      heldRows: 1,
      receivedThrough: 0,
      oldestHeldAt: 300,
    });
  });

  it('drops a member from the backlog once its rows are acked (delete mode)', () => {
    const { sql, surface } = harness();
    seedRow(sql, { identity: 'alice', seq: 1, createdAt: 100 });
    seedRow(sql, { identity: 'alice', seq: 2, createdAt: 200 });

    ackInboxRows(sql, {
      identity: 'alice',
      channelName: SCOPE.channelName,
      channelFamily: SCOPE.channelFamily,
      receivedThrough: 2,
      onDelivered: 'delete',
      now: 1,
    });

    expect(surface.backlog()).toEqual([]);
  });

  it('omits lastSeenAt when no LastSeenService slot is set', () => {
    const { sql, surface } = harness();
    seedRow(sql, { identity: 'alice', seq: 1, createdAt: 100 });

    const [entry] = surface.backlog();
    expect(entry).toBeDefined();
    expect('lastSeenAt' in entry!).toBe(false);
  });

  it('fills lastSeenAt from the LastSeenService slot when set', () => {
    const lastSeen: LastSeenService = {
      at: (identity) => (identity === 'alice' ? 4242 : null),
      online: () => false,
    };
    const { sql, surface } = harness({ lastSeen });
    seedRow(sql, { identity: 'alice', seq: 1, createdAt: 100 });

    const [entry] = surface.backlog();
    expect(entry!.lastSeenAt).toBe(4242);
  });
});
