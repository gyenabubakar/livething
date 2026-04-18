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
import type { EngineAccess } from '~/_engine/access.ts';
import type { ReplayWire } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReplayOptions } from '~/replay/types.ts';

/** The primitive type produced by `replay()`. */
export interface ReplayPrimitive extends Primitive<'replay'> {
  /** The full resolved replay configuration. */
  readonly options: ReplayOptions;
}

/**
 * Convenience type for the function that re-sends one stored message to a
 * specific connection. Used by the replay context extension.
 */
export type ReplaySend = (event: string, payload: unknown, wire: ReplayWire) => void;

/** Unique symbol used to enforce one replay registration per handler scope. */
const REPLAY_KEY = Symbol('replay');

/**
 * Enables built-in message replay. The server records every outgoing message
 * so reconnecting clients can catch up on what they missed — wskit's client
 * asks for replay automatically on reconnect, and no extra work is needed
 * from your handlers.
 *
 * Handlers also get `ctx.sendReplay()` for manually replaying a stored
 * message (e.g. in response to a "load older history" request).
 *
 * `sequence` and `dedup` are enabled automatically if you haven't already
 * registered them. Requires the `storage` platform capability.
 *
 * @example
 * ```ts
 * server('chat')
 *   .replay()
 *   .retention({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 })
 *   .build();
 * ```
 */
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

      const persist = createPersist(opts, engine, channelKey, exclude);

      engine.extendContext(createContextExtender(engine, channelKey));

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

      engine.onProtocolMessage('_replay', createReplayProtocolHandler(engine, channelKey));
    },
  };
}

/** Build the `extendContext` callback that attaches `sendReplay` to the relevant scope. */
function createContextExtender(
  engine: EngineAccess,
  channelKey: string | undefined,
): (ctx: unknown) => Record<string, unknown> {
  return (ctx) => {
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
  };
}

/** Build the persist closure shared by strict/eventual durability branches. */
function createPersist(
  opts: ReplayOptions,
  engine: EngineAccess,
  channelKey: string | undefined,
  exclude: Set<string>,
): (wireMessage: { event: string; payload: Record<string, unknown> }) => void {
  return (wireMessage) => {
    if (!shouldStoreReplayMessage(channelKey, wireMessage.event, wireMessage.payload, exclude))
      return;

    const { sql } = engine.requireStorage();
    const row = persistReplayMessage(sql, opts, wireMessage.event, wireMessage.payload, Date.now());
    pruneExpiredReplayRows(sql, opts.retention, row?.createdAt ?? Date.now());
    pruneReplayScopeRows(sql, opts.retention, readReplayPayloadScope(wireMessage.payload));
  };
}

/** Build the `_replay` protocol handler that fan-outs stored rows to the requester. */
function createReplayProtocolHandler(
  engine: EngineAccess,
  channelKey: string | undefined,
): (ctx: unknown, payload: Record<string, unknown> | undefined) => Promise<boolean> {
  return async (ctx, payload) => {
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
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
replay.__key = REPLAY_KEY;
