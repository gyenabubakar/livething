import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type { ResolvedInboxOptions } from '~/_engine/runtime/feature-slots.ts';
import { advanceReceivedThrough, ensureReceiptsSchema } from './receipts-storage.ts';
import { ensureInboxSchema, loadInboxWatermarks, loadUndeliveredRows } from './storage.ts';
import { buildInboxSurface } from './surface.ts';
import type { BackfillMessage } from './storage.ts';

const SCOPE = { channelName: 'room', channelFamily: null } as const;

function backfillFrame(
  seq: number,
  overrides: { payload?: Record<string, unknown> } = {},
): BackfillMessage {
  return {
    event: 'msg',
    payload: overrides.payload ?? { n: seq },
    __livething: { deliverySeq: seq, messageId: `m${seq}` },
  };
}

function harness(config?: Partial<ResolvedInboxOptions>) {
  const sql = createTestSql();
  ensureInboxSchema(sql);
  ensureReceiptsSchema(sql);

  const resolved: ResolvedInboxOptions | undefined = config
    ? { onDelivered: 'delete', broadcastReceipts: false, maxReceiptAudience: 256, ...config }
    : undefined;

  const engine = {
    storage: { sql },
    isUserOnline: () => false,
    getLastSeenService: () => undefined,
    getInboxChannel: () => resolved,
  } as unknown as EngineAccess;

  return { sql, surface: buildInboxSurface(engine, SCOPE) };
}

describe('inbox surface — backfill()', () => {
  it('writes one row per frame keeping each frame own seq/messageId', () => {
    const { sql, surface } = harness();

    surface.backfill('newcomer', [backfillFrame(1), backfillFrame(2)]);

    expect(loadUndeliveredRows(sql, 'newcomer').map((r) => r.seq)).toEqual([1, 2]);
  });

  it('is a no-op for an anonymous (empty) user id', () => {
    const { sql, surface } = harness();

    surface.backfill('', [backfillFrame(1)]);

    expect(loadUndeliveredRows(sql, '')).toEqual([]);
  });

  it('throws on a non-object payload instead of writing a broken row', () => {
    const { sql, surface } = harness();

    // The type now rejects this, so a TypeScript caller cannot get here. The
    // cast stands in for an untyped JavaScript caller, which still can.
    const bad = {
      event: 'msg',
      payload: 'not-an-object',
      __livething: { deliverySeq: 1, messageId: 'm1' },
    } as unknown as BackfillMessage;

    expect(() => surface.backfill('newcomer', [bad])).toThrow();
    expect(loadUndeliveredRows(sql, 'newcomer')).toEqual([]);
  });

  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map([['key', 'value']])],
    [
      'a class instance',
      new (class Payload {
        value = 1;
      })(),
    ],
  ])('throws on %s payload', (_label, payload) => {
    const { sql, surface } = harness();
    const bad = {
      event: 'msg',
      payload,
      __livething: { deliverySeq: 1, messageId: 'm1' },
    } as unknown as BackfillMessage;

    expect(() => surface.backfill('newcomer', [bad])).toThrow(/plain object/);
    expect(loadUndeliveredRows(sql, 'newcomer')).toEqual([]);
  });

  it('accepts normal and null-prototype objects', () => {
    const { sql, surface } = harness();
    const nullPrototypePayload = Object.create(null) as Record<string, unknown>;
    nullPrototypePayload.kind = 'null-prototype';

    surface.backfill('newcomer', [
      backfillFrame(1, { payload: { kind: 'normal' } }),
      backfillFrame(2, { payload: nullPrototypePayload }),
    ]);

    expect(loadUndeliveredRows(sql, 'newcomer').map((row) => row.seq)).toEqual([1, 2]);
  });

  it("applies the channel's retention to the backfilled rows, same as a live fan-out would", () => {
    const { sql, surface } = harness({ retention: { maxMessages: 2 } });

    surface.backfill('newcomer', [
      backfillFrame(1),
      backfillFrame(2),
      backfillFrame(3),
      backfillFrame(4),
    ]);

    expect(loadUndeliveredRows(sql, 'newcomer').map((r) => r.seq)).toEqual([3, 4]);
    expect(loadInboxWatermarks(sql, 'newcomer')).toEqual([
      { channelName: 'room', channelFamily: null, evictedThroughSeq: 2 },
    ]);
  });

  it('a channel with no inbox settings backfills without retention', () => {
    const { sql, surface } = harness();

    surface.backfill('newcomer', [backfillFrame(1), backfillFrame(2), backfillFrame(3)]);

    expect(loadUndeliveredRows(sql, 'newcomer')).toHaveLength(3);
    expect(loadInboxWatermarks(sql, 'newcomer')).toEqual([]);
  });
});

describe('inbox surface — receiversOf()', () => {
  it('lists only users whose received-through cursor covers the seq', () => {
    const { sql, surface } = harness();

    advanceReceivedThrough(sql, {
      channelName: SCOPE.channelName,
      channelFamily: SCOPE.channelFamily,
      userId: 'alice',
      receivedThrough: 5,
      now: 1,
    });
    advanceReceivedThrough(sql, {
      channelName: SCOPE.channelName,
      channelFamily: SCOPE.channelFamily,
      userId: 'bob',
      receivedThrough: 2,
      now: 1,
    });

    expect(surface.receiversOf(4)).toEqual(['alice']);
    expect(surface.receiversOf(1)).toEqual(expect.arrayContaining(['alice', 'bob']));
  });
});
