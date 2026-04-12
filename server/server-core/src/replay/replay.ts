/* oxlint-disable @typescript-eslint/no-explicit-any */
import { dedup } from '~/dedup/dedup.ts';
import { definePrimitive } from '~/primitive.ts';
import {
  ensureReplaySchema,
  loadReplayRows,
  matchesReplayScope,
  persistReplayMessage,
  pruneExpiredReplayRows,
  pruneReplayScopeRows,
  readReplayContextScope,
  readReplayPayloadScope,
  shouldStoreReplayMessage,
} from '~/replay/runtime.ts';
import { sequence } from '~/sequence/sequence.ts';
import type { ReplayWire } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReplayOptions } from '~/replay/types.ts';

/**
 * The primitive instance returned by `replay()`.
 *
 * Registering this lets wskit record replayable outgoing messages in SQLite
 * and resend them automatically after a reconnect.
 */
export interface ReplayPrimitive extends Primitive<'replay'> {
  readonly options: ReplayOptions;
}

export type ReplaySend = (event: string, payload: unknown, wire: ReplayWire) => void;

const REPLAY_KEY = Symbol('replay');

const _replay = definePrimitive<
  'replay',
  [options?: ReplayOptions],
  {
    options: ReplayOptions;
  }
>({
  tag: 'replay' as const,
  key: REPLAY_KEY,
  kind: 'infrastructure' as const,
  dependencies: [sequence, dedup],
  requires: {
    storage: true,
  },
  create(options?: ReplayOptions) {
    return {
      options: options ?? {},
    };
  },
  setup(engine, data) {
    engine.setReplayEnabled(true);

    const { channelKey } = engine.getScopeInfo();
    const options = data.options;
    const exclude = new Set(options.exclude ?? []);

    engine.onBoot(() => {
      const { sql } = engine.requireStorage();
      ensureReplaySchema(sql);
      pruneExpiredReplayRows(sql, options.retention, Date.now());
    });

    engine.extendContext((ctx) => {
      const base = ctx as Record<PropertyKey, unknown> & {
        id?: string;
        channel?: Record<PropertyKey, unknown>;
        sendReplay?: (event: string, payload: unknown, wire: ReplayWire) => void;
      };
      const scope = readReplayContextScope(base);

      if (channelKey) {
        if (scope.channelScope !== channelKey || !base.id || !base.channel) return {};

        base.channel.sendReplay = (event: string, payload: unknown, wire: ReplayWire) => {
          engine.sendReplay(
            base.id as string,
            scope.channelName,
            scope.channelScope,
            event,
            payload,
            wire,
          );
        };

        return {};
      }

      if (scope.namespaceName || scope.channelName || !base.id) return {};

      base.sendReplay = (event: string, payload: unknown, wire: ReplayWire) => {
        engine.sendReplay(base.id as string, wire.channel, undefined, event, payload, wire);
      };

      return {};
    });

    function persist(wireMessage: { event: string; payload: Record<string, unknown> }): void {
      if (!shouldStoreReplayMessage(channelKey, wireMessage.event, wireMessage.payload, exclude)) {
        return;
      }

      const { sql } = engine.requireStorage();
      const row = persistReplayMessage(
        sql,
        options,
        wireMessage.event,
        wireMessage.payload,
        Date.now(),
      );
      pruneExpiredReplayRows(sql, options.retention, row?.createdAt ?? Date.now());
      pruneReplayScopeRows(sql, options.retention, readReplayPayloadScope(wireMessage.payload));
    }

    if ((options.durability ?? 'strict') === 'strict') {
      engine.onBeforeSend((wireMessage) => {
        persist(wireMessage);
      });
    } else {
      engine.onAfterSend((wireMessage) => {
        return Promise.resolve().then(() => {
          persist(wireMessage);
        });
      });
    }

    engine.onProtocolMessage('_replay', async (ctx, payload) => {
      const scope = readReplayContextScope(ctx as Record<PropertyKey, unknown>);
      if (!matchesReplayScope(channelKey, scope)) return false;

      const since = Number(payload?.since ?? 0);
      const { sql } = engine.requireStorage();
      const rows = loadReplayRows(sql, since, {
        channelName: scope.channelName,
        channelScope: scope.channelScope,
      });

      const connectionId = String((ctx as Record<PropertyKey, unknown>).id ?? '');
      if (!connectionId) return true;

      for (const row of rows) {
        engine.sendReplay(
          connectionId,
          row.channel ?? undefined,
          row.channelScope ?? undefined,
          row.event,
          JSON.parse(row.payload) as Record<string, unknown>,
          {
            seq: row.seq,
            messageId: row.messageId,
            channel: row.channel ?? undefined,
          },
        );
      }

      return true;
    });
  },
});

/**
 * Record outgoing messages in SQLite and resend missed messages automatically
 * when the client sends `_replay`.
 *
 * Replay depends on `sequence()` and `dedup()`, because it stores the `_seq`
 * and `_messageId` metadata those primitives attach to outgoing messages.
 */
export function replay(options?: ReplayOptions): ReplayPrimitive {
  return _replay(options) as ReplayPrimitive;
}

/** Dependency ref — use in `dependencies: [replay]` to assert it's registered. */
replay.__key = REPLAY_KEY;
