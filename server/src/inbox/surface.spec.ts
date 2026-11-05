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
  n: number,
  overrides: { payload?: Record<string, unknown> } = {},
): BackfillMessage {
  return {
    event: 'msg',
    payload: overrides.payload ?? { n },
    __livething: { messageId: `m${n}` },
  };
}

function harness(config?: Partial<ResolvedInboxOptions>, connectionIds: string[] = []) {
  const sql = createTestSql();
  const sent: string[] = [];
  ensureInboxSchema(sql);
  ensureReceiptsSchema(sql);

  const resolved: ResolvedInboxOptions | undefined = config
    ? { broadcastReceipts: false, maxReceiptAudience: 256, ...config }
    : undefined;

  let lastSeq = 0;
  const engine = {
    allocateDeliverySeq: () => (lastSeq += 1),
    getMessageLimits: () => ({ receiveBytes: 32 * 1024 * 1024, sendBytes: 32 * 1024 * 1024 }),
    storage: { sql },
    isUserOnline: () => false,
    userConnectionIdsInChannel: () => connectionIds,
    sendGap: (_id: string, opts: { missedThrough: number }) =>
      sent.push(`gap:${opts.missedThrough}`),
    sendReplay: (_id: string, opts: { wire: { deliverySeq: number } }) =>
      sent.push(`replay:${opts.wire.deliverySeq}`),
    getLastSeenService: () => undefined,
    getInboxChannel: () => resolved,
  } as unknown as EngineAccess;

  return { sql, sent, surface: buildInboxSurface(engine, SCOPE) };
}

describe('inbox surface — backfill()', () => {
  it('writes one row per message, taking each seq from the server counter in order', () => {
    const { sql, surface } = harness();

    surface.backfill('newcomer', [backfillFrame(1), backfillFrame(2)]);

    expect(
      loadUndeliveredRows(sql, 'newcomer').map((r) => ({ seq: r.seq, messageId: r.messageId })),
    ).toEqual([
      { seq: 1, messageId: 'm1' },
      { seq: 2, messageId: 'm2' },
    ]);
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
      __livething: { messageId: 'm1' },
    } as unknown as BackfillMessage;

    expect(() => surface.backfill('newcomer', [bad])).toThrow();
    expect(loadUndeliveredRows(sql, 'newcomer')).toEqual([]);
  });

  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map([['key', 'value']])],
  ])('throws on %s payload', (_label, payload) => {
    const { sql, surface } = harness();
    const bad = {
      event: 'msg',
      payload,
      __livething: { messageId: 'm1' },
    } as unknown as BackfillMessage;

    expect(() => surface.backfill('newcomer', [bad])).toThrow(/plain object/);
    expect(loadUndeliveredRows(sql, 'newcomer')).toEqual([]);
  });

  it('throws on a payload whose toJSON() gives a string, like ctx.send does, instead of writing a broken row', () => {
    const { sql, surface } = harness();
    const bad = {
      event: 'msg',
      payload: { toJSON: () => 'not-an-object' },
      __livething: { messageId: 'm1' },
    } as unknown as BackfillMessage;

    expect(() => surface.backfill('newcomer', [bad])).toThrow(/must be a plain object/);
    expect(loadUndeliveredRows(sql, 'newcomer')).toEqual([]);
  });

  it('accepts a class instance and stores its JSON, as ctx.send would send it', () => {
    const { sql, surface } = harness();
    class Draft {
      constructor(readonly text: string) {}
      toJSON() {
        return { draft: this.text };
      }
    }

    surface.backfill('newcomer', [backfillFrame(1, { payload: new Draft('hi') as never })]);

    expect(loadUndeliveredRows(sql, 'newcomer').map((row) => JSON.parse(row.payload))).toEqual([
      { draft: 'hi' },
    ]);
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

  it('tells an online member about the rows retention dropped, before the rows that survived', () => {
    const { sent, surface } = harness({ retention: { maxMessages: 2 } }, ['conn-1']);

    surface.backfill('newcomer', [
      backfillFrame(1),
      backfillFrame(2),
      backfillFrame(3),
      backfillFrame(4),
    ]);

    expect(sent).toEqual(['gap:2', 'replay:3', 'replay:4']);
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
