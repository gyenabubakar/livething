import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { createTestSql } from '~/_test/sql.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { replay } from '~/replay/replay.ts';
import { ensureReplaySchema, persistReplayMessage } from '~/replay/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type { IncomingProtocolEvent } from '~/_engine/runtime/protocol.ts';
import type { SqlResult, StorageProvider } from '~/context.ts';
import type { ReplayRow } from '~/replay/types.ts';

function replayDb() {
  const sql = createTestSql();
  ensureReplaySchema(sql);
  return sql;
}

function replayRows(sql: ReturnType<typeof createTestSql>): ReplayRow[] {
  return sql
    .exec<ReplayRow>(
      `SELECT rowKey, messageId, seq, event, payload, channel, channelFamily, snapshotKey, createdAt
       FROM __wskit_replay`,
    )
    .toArray();
}

describe('replay', () => {
  it('produces correct tag and kind', () => {
    const p = replay();
    expect(p.__wskit).toBe('replay');
    expect(p.__kind).toBe('infrastructure');
  });

  it('uses singleton identity', () => {
    const p = replay();
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(replay.__key);
  });

  it('declares dependencies and requires', () => {
    const p = replay();
    expect(p.__requires).toEqual({});
  });

  it('stores automatic replay options when provided', () => {
    const p = replay({
      type: 'snapshot',
      durability: 'best-effort',
      exclude: ['typing'],
      retention: {
        maxAgeMs: 60_000,
        maxMessages: 10,
      },
    });

    expect(p.options).toEqual({
      type: 'snapshot',
      durability: 'best-effort',
      exclude: ['typing'],
      retention: {
        maxAgeMs: 60_000,
        maxMessages: 10,
      },
    });
  });

  it('reduces snapshot rows when a reducer is provided', () => {
    const sql = replayDb();

    persistReplayMessage(sql, {
      options: {
        type: 'snapshot',
        snapshotKey(_event: string, payload: Record<string, unknown>) {
          return String(payload.id);
        },
        reduce(previous, next) {
          if (!previous) return next;

          return {
            event: 'doc-snapshot',
            payload: {
              ...previous.payload,
              ...next.payload,
            },
          };
        },
      },
      event: 'doc-title-set',
      payload: { id: 'doc-1', title: 'Draft' },
      wskit: { seq: 1, messageId: 'm1' },
      now: 1,
    });

    persistReplayMessage(sql, {
      options: {
        type: 'snapshot',
        snapshotKey(_event: string, payload: Record<string, unknown>) {
          return String(payload.id);
        },
        reduce(previous, next) {
          if (!previous) return next;

          return {
            event: 'doc-snapshot',
            payload: {
              ...previous.payload,
              ...next.payload,
            },
          };
        },
      },
      event: 'doc-content-set',
      payload: { id: 'doc-1', content: 'Hello' },
      wskit: { seq: 2, messageId: 'm2' },
      now: 2,
    });

    expect(replayRows(sql).length).toBe(1);
    expect(replayRows(sql)[0]).toMatchObject({
      event: 'doc-snapshot',
      seq: 2,
      messageId: 'm2',
    });
    expect(JSON.parse(replayRows(sql)[0]!.payload)).toEqual({
      id: 'doc-1',
      title: 'Draft',
      content: 'Hello',
    });
  });

  it('deletes a snapshot when the reducer returns null', () => {
    const sql = replayDb();

    persistReplayMessage(sql, {
      options: {
        type: 'snapshot',
        snapshotKey(_event: string, payload: Record<string, unknown>) {
          return String(payload.id);
        },
      },
      event: 'message-created',
      payload: { id: 'm1', text: 'Hello' },
      wskit: { seq: 1, messageId: 'm1' },
      now: 1,
    });

    const deleted = persistReplayMessage(sql, {
      options: {
        type: 'snapshot',
        snapshotKey(_event: string, payload: Record<string, unknown>) {
          return String(payload.id);
        },
        reduce(_previous, next) {
          if (next.event === 'message-deleted') return null;

          return next;
        },
      },
      event: 'message-deleted',
      payload: { id: 'm1' },
      wskit: { seq: 2, messageId: 'm2' },
      now: 2,
    });

    expect(deleted).toBeNull();
    expect(replayRows(sql).length).toBe(0);
  });

  it('validates the reduced value against the contract before storing it', () => {
    const sql = replayDb();
    const seen: Array<{ event: string; payload: Record<string, unknown> }> = [];

    persistReplayMessage(sql, {
      options: {
        type: 'snapshot',
        snapshotKey: (_event, payload) => String(payload.id),
        reduce: (_previous, next) => ({ event: 'doc-snapshot', payload: next.payload }),
      },
      event: 'doc-title-set',
      payload: { id: 'doc-1', title: 'Draft' },
      wskit: { seq: 1, messageId: 'm1' },
      now: 1,
      validateReduced: (event, payload) => seen.push({ event, payload }),
    });

    expect(seen).toEqual([{ event: 'doc-snapshot', payload: { id: 'doc-1', title: 'Draft' } }]);
  });

  it('does not store the row when reduced-value validation throws', () => {
    const sql = replayDb();

    expect(() =>
      persistReplayMessage(sql, {
        options: {
          type: 'snapshot',
          snapshotKey: (_event, payload) => String(payload.id),
          reduce: (_previous, next) => ({ event: 'not-declared', payload: next.payload }),
        },
        event: 'doc-title-set',
        payload: { id: 'doc-1', title: 'Draft' },
        wskit: { seq: 1, messageId: 'm1' },
        now: 1,
        validateReduced: () => {
          throw new Error('not a declared outgoing event');
        },
      }),
    ).toThrow(/not a declared outgoing event/);

    expect(replayRows(sql).length).toBe(0);
  });

  it('does not validate when no reducer is configured (live send already checked it)', () => {
    const sql = replayDb();
    let called = false;

    persistReplayMessage(sql, {
      options: { type: 'snapshot', snapshotKey: (_event, payload) => String(payload.id) },
      event: 'doc-snapshot',
      payload: { id: 'doc-1', title: 'Draft' },
      wskit: { seq: 1, messageId: 'm1' },
      now: 1,
      validateReduced: () => {
        called = true;
      },
    });

    expect(called).toBe(false);
    expect(replayRows(sql).length).toBe(1);
  });

  it('adds top-level sendReplay through a context extender', () => {
    const extenders: Array<NonNullable<Parameters<EngineAccess['extendContext']>[0]>> = [];
    const engine = {
      getScopeInfo() {
        return {};
      },
      extendContext(factory) {
        extenders.push(factory);
      },
      setReplayEnabled() {},
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onBeforeSend() {},
      onAfterSend() {},
      onBoot() {},
      onBootSchema() {},
      onProtocolMessage() {},
      sendReplay() {},
    } as Pick<
      EngineAccess,
      | 'extendContext'
      | 'getScopeInfo'
      | 'onAfterSend'
      | 'onBeforeSend'
      | 'onBoot'
      | 'onProtocolMessage'
      | 'setReplayEnabled'
      | 'getReplayClaimedChannelKeys'
      | 'sendReplay'
    > as EngineAccess;

    replay().__setup?.(engine);

    const ctx: Record<PropertyKey, unknown> = {
      connection: { id: 'c1' },
      [ENGINE_CHANNEL_META]: {},
    };

    extenders[0]!(ctx);

    expect(typeof ctx.sendReplay).toBe('function');
  });

  it('top-level sendReplay forwards wire.channelFamily into engine.sendReplay', () => {
    const extenders: Array<NonNullable<Parameters<EngineAccess['extendContext']>[0]>> = [];
    const sent: Parameters<EngineAccess['sendReplay']>[] = [];
    const engine = {
      getScopeInfo() {
        return {};
      },
      extendContext(factory) {
        extenders.push(factory);
      },
      setReplayEnabled() {},
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onBeforeSend() {},
      onAfterSend() {},
      onBoot() {},
      onBootSchema() {},
      onProtocolMessage() {},
      sendReplay(...args: Parameters<EngineAccess['sendReplay']>) {
        sent.push(args);
      },
      assertReplaySendContract() {},
    } as Pick<
      EngineAccess,
      | 'extendContext'
      | 'getScopeInfo'
      | 'onAfterSend'
      | 'onBeforeSend'
      | 'onBoot'
      | 'onProtocolMessage'
      | 'setReplayEnabled'
      | 'getReplayClaimedChannelKeys'
      | 'sendReplay'
      | 'assertReplaySendContract'
    > as EngineAccess;

    replay().__setup?.(engine);

    const ctx: Record<PropertyKey, unknown> = {
      connection: { id: 'c1' },
      [ENGINE_CHANNEL_META]: {},
    };

    extenders[0]!(ctx);

    (ctx.sendReplay as (event: string, payload: unknown, wire: unknown) => void)(
      'message',
      { text: 'hi' },
      { seq: 7, messageId: 'm7', channel: 'room-1', channelFamily: 'rooms' },
    );

    expect(sent).toHaveLength(1);
    const [, opts] = sent[0]!;
    expect(opts.channelName).toBe('room-1');
    expect(opts.channelFamily).toBe('rooms');
  });

  it('adds channel sendReplay only for the matching channel scope', () => {
    const extenders: Array<NonNullable<Parameters<EngineAccess['extendContext']>[0]>> = [];
    const engine = {
      getScopeInfo() {
        return { channelKey: 'rooms' };
      },
      extendContext(factory) {
        extenders.push(factory);
      },
      setReplayEnabled() {},
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onBeforeSend() {},
      onAfterSend() {},
      onBoot() {},
      onBootSchema() {},
      onProtocolMessage() {},
      sendReplay() {},
    } as Pick<
      EngineAccess,
      | 'extendContext'
      | 'getScopeInfo'
      | 'onAfterSend'
      | 'onBeforeSend'
      | 'onBoot'
      | 'onProtocolMessage'
      | 'setReplayEnabled'
      | 'getReplayClaimedChannelKeys'
      | 'sendReplay'
    > as EngineAccess;

    replay().__setup?.(engine);

    const matchingCtx: Record<PropertyKey, unknown> = {
      connection: { id: 'c1' },
      channel: { name: 'room-1' },
      [ENGINE_CHANNEL_META]: {
        channelName: 'room-1',
        channelFamily: 'rooms',
      },
    };

    const otherCtx: Record<PropertyKey, unknown> = {
      id: 'c2',
      channel: { name: 'other' },
      [ENGINE_CHANNEL_META]: {
        channelName: 'other',
        channelFamily: 'other-scope',
      },
    };

    extenders[0]!(matchingCtx);
    extenders[0]!(otherCtx);

    expect(typeof (matchingCtx.channel as { sendReplay?: unknown }).sendReplay).toBe('function');
    expect((otherCtx.channel as { sendReplay?: unknown }).sendReplay).toBeUndefined();
  });

  it('handles only matching protocol replay requests', async () => {
    const protocolHandlers: Array<NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>> =
      [];
    const sent: Array<Parameters<EngineAccess['sendReplay']>> = [];
    const rows = [
      {
        rowKey: 'row-1',
        messageId: 'msg-1',
        seq: 5,
        event: 'message',
        payload: JSON.stringify({ text: 'history' }),
        channel: 'room-1',
        channelFamily: 'rooms',
        snapshotKey: null,
        createdAt: 1,
      },
    ];
    const engine = {
      getScopeInfo() {
        return { channelKey: 'rooms' };
      },
      extendContext() {},
      setReplayEnabled() {},
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onBeforeSend() {},
      onAfterSend() {},
      onBoot() {},
      onBootSchema() {},
      storage: {
        sql: {
          exec<TRow = unknown>() {
            return {
              toArray() {
                return rows as TRow[];
              },
              one() {
                return (rows[0] as TRow | undefined) ?? null;
              },
              raw() {
                return [];
              },
            };
          },
          transaction<T>(
            fn: (tx: {
              exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow>;
            }) => T,
          ) {
            return fn(this);
          },
          limits: {
            maxBoundParams: 32_766,
            maxStatementBytes: 1_000_000_000,
            maxValueBytes: 1_000_000_000,
          },
        },
        kv: {
          async get() {
            return undefined;
          },
          async set() {},
          async delete() {},
          async list() {
            return [];
          },
        },
      } satisfies StorageProvider,
      sendReplay(...args: Parameters<EngineAccess['sendReplay']>) {
        sent.push(args);
      },
      onProtocolMessage(
        event: IncomingProtocolEvent,
        handler: NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>,
      ) {
        if (event === '__replay__') protocolHandlers.push(handler);
      },
    } as unknown as Pick<
      EngineAccess,
      | 'extendContext'
      | 'getScopeInfo'
      | 'onAfterSend'
      | 'onBeforeSend'
      | 'onBoot'
      | 'onProtocolMessage'
      | 'storage'
      | 'setReplayEnabled'
      | 'getReplayClaimedChannelKeys'
      | 'sendReplay'
    > as EngineAccess;

    replay().__setup?.(engine);

    const handler = protocolHandlers[0]!;
    const memberConnection = {
      channelMemberships: new Map([
        [
          createChannelMembershipKey('room-1', 'rooms'),
          { channelName: 'room-1', channelFamily: 'rooms' },
        ],
      ]),
    };

    const matchingCtx = {
      connection: { id: 'c1' },
      [ENGINE_CHANNEL_META]: {
        channelName: 'room-1',
        channelFamily: 'rooms',
      },
      [ENGINE_INTERNAL_CONNECTION]: memberConnection,
    };

    const nonMemberCtx = {
      id: 'c3',
      [ENGINE_CHANNEL_META]: {
        channelName: 'room-1',
        channelFamily: 'rooms',
      },
      [ENGINE_INTERNAL_CONNECTION]: { channelMemberships: new Map() },
    };

    expect(
      await handler(matchingCtx, {
        event: '__replay__',
        payload: { lastKnownSeq: 4 },
        __wskit: { channel: 'room-1', channelFamily: 'rooms' },
      }),
    ).toBe(true);
    expect(
      await handler(
        { id: 'c2', [ENGINE_CHANNEL_META]: {} },
        { event: '__replay__', payload: { lastKnownSeq: 9 }, __wskit: { channelFamily: null } },
      ),
    ).toBe(false);
    expect(
      await handler(nonMemberCtx, {
        event: '__replay__',
        payload: { lastKnownSeq: 4 },
        __wskit: { channel: 'room-1', channelFamily: 'rooms' },
      }),
    ).toBe(true);
    expect(sent).toEqual([
      [
        'c1',
        {
          channelName: 'room-1',
          channelFamily: 'rooms',
          event: 'message',
          payload: { text: 'history' },
          wire: { seq: 5, messageId: 'msg-1', channel: 'room-1' },
        },
      ],
    ]);
  });

  describe('__gap__ emission', () => {
    interface GapSetup {
      /** Watermark per scope_key ('' is top-level). A missing key reads as null. */
      watermarks?: Record<string, number>;
      type?: 'history' | 'snapshot';
      channelKey?: string;
    }

    function setupGapHandler({ watermarks = {}, type, channelKey }: GapSetup) {
      const protocolHandlers: Array<NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>> =
        [];
      const gaps: Array<Parameters<EngineAccess['sendGap']>> = [];
      const replays: Array<Parameters<EngineAccess['sendReplay']>> = [];
      const watermarkReads: unknown[] = [];

      const engine = {
        getScopeInfo() {
          return channelKey ? { channelKey } : {};
        },
        extendContext() {},
        setReplayEnabled() {},
        getReplayClaimedChannelKeys() {
          return new Set();
        },
        onBeforeSend() {},
        onAfterSend() {},
        onBoot() {},
        onBootSchema() {},
        storage: {
          sql: {
            exec<TRow = unknown>(query: string, ...params: unknown[]) {
              const normalized = query.replaceAll(/\s+/g, ' ').trim();
              const isWatermarkRead = normalized.startsWith(
                'SELECT evicted_through_seq FROM __wskit_replay_watermark',
              );
              // Faithfully key the watermark read on the scope_key param, so a
              // handler that reads the WRONG scope's watermark fails the test.
              const scopeKey = String(params[0] ?? '');
              if (isWatermarkRead) watermarkReads.push(scopeKey);

              return {
                toArray() {
                  return [] as TRow[];
                },
                one() {
                  if (isWatermarkRead && scopeKey in watermarks) {
                    return { evicted_through_seq: watermarks[scopeKey] } as TRow;
                  }

                  return null;
                },
                raw() {
                  return [];
                },
              };
            },
            transaction<T>(
              fn: (tx: {
                exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow>;
              }) => T,
            ) {
              return fn(this);
            },
            limits: {
              maxBoundParams: 32_766,
              maxStatementBytes: 1_000_000_000,
              maxValueBytes: 1_000_000_000,
            },
          },
          kv: {
            async get() {
              return undefined;
            },
            async set() {},
            async delete() {},
            async list() {
              return [];
            },
          },
        } satisfies StorageProvider,
        sendReplay(...args: Parameters<EngineAccess['sendReplay']>) {
          replays.push(args);
        },
        sendGap(...args: Parameters<EngineAccess['sendGap']>) {
          gaps.push(args);
        },
        onProtocolMessage(
          event: IncomingProtocolEvent,
          handler: NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>,
        ) {
          if (event === '__replay__') protocolHandlers.push(handler);
        },
      } as unknown as EngineAccess;

      const factory = type === 'snapshot' ? { type: 'snapshot' as const } : undefined;
      replay(factory).__setup?.(engine);

      return { handler: protocolHandlers[0]!, gaps, replays, watermarkReads };
    }

    const topLevelCtx = { connection: { id: 'c1' }, [ENGINE_CHANNEL_META]: {} };
    const topLevelFrame = {
      event: '__replay__' as const,
      payload: { lastKnownSeq: 4 },
      __wskit: { channelFamily: null },
    };

    it('emits __gap__ when since is below the top-level watermark in history mode', async () => {
      const { handler, gaps, watermarkReads } = setupGapHandler({ watermarks: { '': 10 } });
      await handler(topLevelCtx, topLevelFrame);
      expect(gaps).toEqual([['c1', { channelName: null, channelFamily: null, missedThrough: 10 }]]);
      // The top-level scope reads the '' key, not a channel key.
      expect(watermarkReads).toEqual(['']);
    });

    it('does not emit __gap__ when since equals the watermark (boundary)', async () => {
      const { handler, gaps } = setupGapHandler({ watermarks: { '': 4 } });
      await handler(topLevelCtx, topLevelFrame);
      expect(gaps).toEqual([]);
    });

    it('does not emit __gap__ when since is above the watermark', async () => {
      const { handler, gaps } = setupGapHandler({ watermarks: { '': 2 } });
      await handler(topLevelCtx, topLevelFrame);
      expect(gaps).toEqual([]);
    });

    it('does not emit __gap__ for a fresh subscriber (since 0)', async () => {
      const { handler, gaps } = setupGapHandler({ watermarks: { '': 10 } });
      await handler(topLevelCtx, {
        event: '__replay__',
        payload: {},
        __wskit: { channelFamily: null },
      });
      expect(gaps).toEqual([]);
    });

    it('does not emit __gap__ when the scope has no watermark yet', async () => {
      const { handler, gaps } = setupGapHandler({});
      await handler(topLevelCtx, topLevelFrame);
      expect(gaps).toEqual([]);
    });

    it('does not emit __gap__ in snapshot mode even when since is below the watermark', async () => {
      const { handler, gaps } = setupGapHandler({ watermarks: { '': 10 }, type: 'snapshot' });
      await handler(topLevelCtx, topLevelFrame);
      expect(gaps).toEqual([]);
    });

    it('emits a channel-scoped __gap__ read from the channel scope_key, with channel markers', async () => {
      // The channel watermark lives under the membership-style key; a matching
      // top-level watermark must NOT be read for a channel request.
      const channelScopeKey = JSON.stringify(['rooms', 'room-1']);
      const { handler, gaps, watermarkReads } = setupGapHandler({
        channelKey: 'rooms',
        watermarks: { [channelScopeKey]: 12, '': 999 },
      });
      const memberConnection = {
        channelMemberships: new Map([
          [
            createChannelMembershipKey('room-1', 'rooms'),
            { channelName: 'room-1', channelFamily: 'rooms' },
          ],
        ]),
      };

      const channelCtx = {
        connection: { id: 'c1' },
        [ENGINE_CHANNEL_META]: { channelName: 'room-1', channelFamily: 'rooms' },
        [ENGINE_INTERNAL_CONNECTION]: memberConnection,
      };

      await handler(channelCtx, {
        event: '__replay__',
        payload: { lastKnownSeq: 4 },
        __wskit: { channel: 'room-1', channelFamily: 'rooms' },
      });

      expect(gaps).toEqual([
        ['c1', { channelName: 'room-1', channelFamily: 'rooms', missedThrough: 12 }],
      ]);
      expect(watermarkReads).toEqual([channelScopeKey]);
    });

    it('does not emit __gap__ to a non-member (authorization gate runs first)', async () => {
      const channelScopeKey = JSON.stringify(['rooms', 'room-1']);
      const { handler, gaps, watermarkReads } = setupGapHandler({
        channelKey: 'rooms',
        watermarks: { [channelScopeKey]: 12 },
      });
      const nonMemberCtx = {
        id: 'c9',
        [ENGINE_CHANNEL_META]: { channelName: 'room-1', channelFamily: 'rooms' },
        [ENGINE_INTERNAL_CONNECTION]: { channelMemberships: new Map() },
      };

      const result = await handler(nonMemberCtx, {
        event: '__replay__',
        payload: { lastKnownSeq: 4 },
        __wskit: { channel: 'room-1', channelFamily: 'rooms' },
      });

      expect(result).toBe(true);
      expect(gaps).toEqual([]);
      // The watermark is never even read — the auth gate returns before gap detection,
      // so channel existence can't leak to a non-member.
      expect(watermarkReads).toEqual([]);
    });
  });

  it('replay(false) returns a disabled primitive with no setup work', () => {
    const primitive = replay(false);
    expect(primitive.disabled).toBe(true);
    expect(primitive.options).toEqual({});
    expect(primitive.__requires).toEqual({});
    // The disabled primitive intentionally has no __setup so nothing wires
    // hooks for this scope. Its only purpose is to mark the scope as claimed
    // at compile time.
    expect(primitive.__setup).toBeUndefined();
  });
});
