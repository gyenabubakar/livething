/* oxlint-disable @typescript-eslint/no-explicit-any */
import { dedup } from '~/dedup/dedup.ts';
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

export interface ReplayPrimitive extends Primitive<'replay'> {
  readonly options: ReplayOptions;
}

export type ReplaySend = (event: string, payload: unknown, wire: ReplayWire) => void;

const REPLAY_KEY = Symbol('replay');

export function replay(options?: ReplayOptions): ReplayPrimitive {
  const opts = options ?? {};

  return {
    __wskit: 'replay',
    __kind: 'infrastructure',
    __identity: [REPLAY_KEY],
    __dependencies: [sequence, dedup],
    __requires: { storage: true },
    options: opts,
    __setup(engine) {
      engine.setReplayEnabled(true);

      const { channelKey } = engine.getScopeInfo();
      const exclude = new Set(opts.exclude ?? []);

      engine.onBoot(() => {
        const { sql } = engine.requireStorage();
        ensureReplaySchema(sql);
        pruneExpiredReplayRows(sql, opts.retention, Date.now());
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
        if (!shouldStoreReplayMessage(channelKey, wireMessage.event, wireMessage.payload, exclude))
          return;

        const { sql } = engine.requireStorage();
        const row = persistReplayMessage(
          sql,
          opts,
          wireMessage.event,
          wireMessage.payload,
          Date.now(),
        );
        pruneExpiredReplayRows(sql, opts.retention, row?.createdAt ?? Date.now());
        pruneReplayScopeRows(sql, opts.retention, readReplayPayloadScope(wireMessage.payload));
      }

      if ((opts.durability ?? 'strict') === 'strict') {
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
            { seq: row.seq, messageId: row.messageId, channel: row.channel ?? undefined },
          );
        }

        return true;
      });
    },
  };
}

replay.__key = REPLAY_KEY;
