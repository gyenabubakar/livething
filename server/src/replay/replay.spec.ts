import { ENGINE_INTERNAL_CONNECTION, ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { replay } from '~/replay/replay.ts';
import { persistReplayMessage } from '~/replay/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type { IncomingProtocolEvent } from '~/_engine/runtime/types.ts';
import type { SqlResult, StorageProvider } from '~/context.ts';
import type { ReplayRow } from '~/replay/types.ts';

class FakeReplaySql {
  rows = new Map<string, ReplayRow>();

  exec<TRow = unknown>(query: string, ...params: unknown[]) {
    const normalizedQuery = query.replaceAll(/\s+/g, ' ').trim();

    if (
      normalizedQuery.startsWith(
        'SELECT rowKey, messageId, seq, event, payload, namespace, channel, channelScope, snapshotKey, createdAt FROM __wskit_replay WHERE rowKey = ?',
      )
    ) {
      const row = this.rows.get(String(params[0]));
      return {
        toArray() {
          return row ? ([row] as TRow[]) : [];
        },
        one() {
          return (row as TRow | undefined) ?? null;
        },
        raw() {
          return row ? [Object.values(row)] : [];
        },
      };
    }

    if (normalizedQuery.startsWith('DELETE FROM __wskit_replay WHERE rowKey = ?')) {
      this.rows.delete(String(params[0]));
      return {
        toArray() {
          return [] as TRow[];
        },
        one() {
          return null as TRow | null;
        },
        raw() {
          return [];
        },
      };
    }

    if (normalizedQuery.startsWith('INSERT OR REPLACE INTO __wskit_replay')) {
      const row: ReplayRow = {
        rowKey: String(params[0]),
        messageId: String(params[1]),
        seq: Number(params[2]),
        event: String(params[3]),
        payload: String(params[4]),
        namespace: (params[5] as string | null) ?? null,
        channel: (params[6] as string | null) ?? null,
        channelScope: (params[7] as string | null) ?? null,
        snapshotKey: (params[8] as string | null) ?? null,
        createdAt: Number(params[9]),
      };
      this.rows.set(row.rowKey, row);
      return {
        toArray() {
          return [] as TRow[];
        },
        one() {
          return null as TRow | null;
        },
        raw() {
          return [];
        },
      };
    }

    return {
      toArray() {
        return [] as TRow[];
      },
      one() {
        return null as TRow | null;
      },
      raw() {
        return [];
      },
    };
  }

  transaction<T>(fn: (tx: { exec: FakeReplaySql['exec'] }) => T): T {
    return fn({ exec: this.exec.bind(this) });
  }
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
    expect(p.__requires).toEqual({ storage: true });
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
    const sql = new FakeReplaySql();

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

    expect(sql.rows.size).toBe(1);
    expect([...sql.rows.values()][0]).toMatchObject({
      event: 'doc-snapshot',
      seq: 2,
      messageId: 'm2',
    });
    expect(JSON.parse([...sql.rows.values()][0]!.payload)).toEqual({
      id: 'doc-1',
      title: 'Draft',
      content: 'Hello',
    });
  });

  it('deletes a snapshot when the reducer returns null', () => {
    const sql = new FakeReplaySql();

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
    expect(sql.rows.size).toBe(0);
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
      id: 'c1',
      [ENGINE_SCOPE_META]: {},
    };

    extenders[0]!(ctx);

    expect(typeof ctx.sendReplay).toBe('function');
  });

  it('top-level sendReplay forwards wire.channelScope into engine.sendReplay', () => {
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

    const ctx: Record<PropertyKey, unknown> = { id: 'c1', [ENGINE_SCOPE_META]: {} };
    extenders[0]!(ctx);

    (ctx.sendReplay as (event: string, payload: unknown, wire: unknown) => void)(
      'message',
      { text: 'hi' },
      { seq: 7, messageId: 'm7', channel: 'room-1', channelScope: 'rooms' },
    );

    expect(sent).toHaveLength(1);
    const [, opts] = sent[0]!;
    expect(opts.channelName).toBe('room-1');
    expect(opts.channelScope).toBe('rooms');
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
      id: 'c1',
      channel: { name: 'room-1' },
      [ENGINE_SCOPE_META]: {
        channelName: 'room-1',
        channelScope: 'rooms',
      },
    };
    const otherCtx: Record<PropertyKey, unknown> = {
      id: 'c2',
      channel: { name: 'other' },
      [ENGINE_SCOPE_META]: {
        channelName: 'other',
        channelScope: 'other-scope',
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
        namespace: null,
        channel: 'room-1',
        channelScope: 'rooms',
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
      requireStorage(): StorageProvider {
        return {
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
        };
      },
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
      | 'requireStorage'
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
          { channelName: 'room-1', channelScope: 'rooms' },
        ],
      ]),
    };
    const matchingCtx = {
      id: 'c1',
      [ENGINE_SCOPE_META]: {
        channelName: 'room-1',
        channelScope: 'rooms',
      },
      [ENGINE_INTERNAL_CONNECTION]: memberConnection,
    };
    const nonMemberCtx = {
      id: 'c3',
      [ENGINE_SCOPE_META]: {
        channelName: 'room-1',
        channelScope: 'rooms',
      },
      [ENGINE_INTERNAL_CONNECTION]: { channelMemberships: new Map() },
    };

    expect(
      await handler(matchingCtx, {
        event: '__replay__',
        payload: { lastKnownSeq: 4 },
        __wskit: { channel: 'room-1', channelScope: 'rooms' },
      }),
    ).toBe(true);
    expect(
      await handler(
        { id: 'c2', [ENGINE_SCOPE_META]: {} },
        { event: '__replay__', payload: { lastKnownSeq: 9 }, __wskit: { channelScope: null } },
      ),
    ).toBe(false);
    expect(
      await handler(nonMemberCtx, {
        event: '__replay__',
        payload: { lastKnownSeq: 4 },
        __wskit: { channel: 'room-1', channelScope: 'rooms' },
      }),
    ).toBe(true);
    expect(sent).toEqual([
      [
        'c1',
        {
          channelName: 'room-1',
          channelScope: 'rooms',
          namespace: null,
          event: 'message',
          payload: { text: 'history' },
          wire: { seq: 5, messageId: 'msg-1', channel: 'room-1', namespace: null },
        },
      ],
    ]);
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
