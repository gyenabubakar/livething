/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { assertOneOf, assertOptionalPositiveInteger } from '~/_engine/validation.ts';
import {
  ensureReplaySchema,
  isChannelReplayAuthorized,
  loadReplayRows,
  matchesReplayScope,
  persistReplayMessage,
  pruneExpiredReplayRows,
  pruneReplayScopeRows,
  readReplayContextScope,
  readReplayGapWatermark,
  readReplayScope,
  ReplayPruneGate,
  shouldStoreReplayMessage,
} from '~/replay/runtime.ts';
import { createSendReplayExtender, readConnectionId } from '~/replay/send-replay.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { RuntimeConnection, WireBroadcastMessage } from '~/_engine/runtime/types.ts';
import type { SQLProvider } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReplaySnapshotEntry, ReplayStoreOwner } from '~/replay/runtime.ts';
import type { ReplayOptions } from '~/replay/types.ts';
import type { ReplayWire } from './wire.ts';

/** The primitive type produced by `replay.history()` and `replay.snapshot()`. */
export interface ReplayPrimitive extends Primitive<'replay'> {
  /** The full resolved replay configuration. */
  readonly options: ReplayOptions;
  /**
   * `true` when the developer registered `replay(false)` to opt out of cascade
   * for this scope. Disabled primitives carry no setup work; they only exist to
   * appear in the compile-time claimed-scope map so server-level replay knows
   * to skip this scope.
   */
  readonly disabled?: boolean;
}

/**
 * Convenience type for the function that re-sends one stored message to a
 * specific connection. Used by the replay context extension.
 */
export type ReplaySend = (event: string, payload: unknown, wire: ReplayWire) => void;

/** Unique symbol used to enforce one replay registration per handler scope. */
const REPLAY_KEY = Symbol('replay');

/**
 * Enables built-in message replay. The server records every broadcast so
 * reconnecting clients can catch up on what they missed — LiveThing's client
 * asks for replay automatically on reconnect, and no extra work is needed
 * from your handlers.
 *
 * **What is recorded.** A client only ever replays frames addressed to it:
 *
 * - A broadcast to everyone in a scope (`ctx.broadcast`, `ctx.channel.broadcast`)
 *   is recorded once — even when no connection receives it live — and replays
 *   to anyone who may read that scope (for a channel, its current members).
 * - A broadcast to one user (`ctx.user.broadcast`, `ctx.users.get(id).broadcast`,
 *   `ctx.channel.broadcastTo(userRef, ...)`) is recorded once for that user and
 *   replays only to a connection of that same user. An anonymous connection
 *   never receives it.
 * - A send to one connection (`ctx.send`, `ctx.connections.get(ref).send`,
 *   `ctx.channel.send`, `ctx.channel.broadcastTo(connectionRef, ...)`) and a tag
 *   or group broadcast are not recorded. A reconnect opens a new connection
 *   with a new id, so no later connection could prove it was the one addressed.
 *   To send the caller a copy it can replay, broadcast with
 *   `{ includeSelf: true }` instead.
 *
 * **Cascade behavior.** A server-level `replay: true` captures every outgoing
 * message, including channel-scoped traffic. To use a different replay
 * strategy for one channel, add `replay: true` inside that channel's
 * `definitions` — the server-level replay then skips that channel. To opt a
 * specific channel out of replay entirely, add `replay: false` inside its
 * `definitions`; messages on that channel are not stored or replayed by
 * either the server-level or channel-level replay.
 *
 * Handlers also get `ctx.sendReplay()` for manually replaying a stored
 * message (e.g. in response to a "load older history" request).
 *
 * Replay requires the `dedup()` and `sequence({ persist: true })` capabilities —
 * dedup stamps the `messageId` replay keys off, and persistent sequence keeps
 * `seq` stable across restarts so stored rows order correctly. The build fails
 * fast if either is missing. Also requires the `storage` platform capability.
 *
 * Enable this by listing the `replay.history({...})` capability instead of
 * calling this primitive directly.
 *
 * @example
 * ```ts
 * import { server, t } from '@livething/server';
 * import { dedup } from '@livething/server/dedup';
 * import { sequence } from '@livething/server/sequence';
 * import { replay } from '@livething/server/replay';
 *
 * const base = server({
 *   capabilities: [
 *     dedup(),
 *     sequence({ persist: true }),
 *     replay.history({ retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000 } }),
 *   ],
 * });
 * ```
 */
export function replay(options?: ReplayOptions | false): ReplayPrimitive {
  if (options === false) {
    return {
      __livething: 'replay',
      __kind: 'infrastructure',
      __identity: [REPLAY_KEY],
      __requires: {},
      options: {},
      disabled: true,
    };
  }

  const opts = options ?? {};
  if (opts.retention) {
    assertOptionalPositiveInteger(opts.retention.maxAgeMs, 'retention.maxAgeMs', 'replay()');
    assertOptionalPositiveInteger(opts.retention.maxMessages, 'retention.maxMessages', 'replay()');
  }

  if (opts.durability !== undefined) {
    assertOneOf(opts.durability, ['strict', 'best-effort'] as const, {
      field: 'durability',
      context: 'replay()',
    });
  }

  if (opts.type !== undefined) {
    assertOneOf(opts.type, ['history', 'snapshot'] as const, {
      field: 'type',
      context: 'replay()',
    });
  }

  return {
    __livething: 'replay',
    __kind: 'infrastructure',
    __identity: [REPLAY_KEY],
    __requires: {},
    __requiresCapabilities: [CAPABILITY_KIND.dedup, CAPABILITY_KIND.sequence],
    options: opts,
    __setup(engine) {
      engine.setReplayEnabled(true);

      const { channelKey } = engine.getScopeInfo();
      const exclude = new Set(opts.exclude ?? []);

      const installer = new ReplayInstaller({ engine, channelKey, exclude, opts });

      engine.onBootSchema(() => {
        ensureReplaySchema(engine.storage.sql);
      });
      engine.onBoot(() => {
        pruneExpiredReplayRows(engine.storage.sql, {
          retention: opts.retention,
          now: Date.now(),
          owner: installer.owner(),
        });
      });

      engine.extendContext(
        createSendReplayExtender(engine, {
          channelKey,
          claimedChannelKeys: () => engine.getReplayClaimedChannelKeys(),
        }),
      );

      if ((opts.durability ?? 'strict') === 'strict') {
        engine.onBeforeBroadcast(installer.persist);
      } else {
        engine.onAfterBroadcast((message) => {
          return Promise.resolve().then(() => {
            installer.persist(message);
          });
        });
      }

      engine.onProtocolMessage('__replay__', installer.protocolHandler);
    },
  };
}

interface ReplayInstallerOptions {
  engine: EngineAccess;

  channelKey: string | undefined;

  exclude: Set<string>;

  opts: ReplayOptions;
}

/**
 * Bundles the persist callback and `__replay__` protocol handler used during
 * replay setup. Using a class lets the callbacks share the same engine
 * reference, channel key, exclude set, and options without repeating the
 * constructor arguments.
 *
 * @internal
 */
class ReplayInstaller {
  private readonly engine: EngineAccess;
  private readonly channelKey: string | undefined;
  private readonly exclude: Set<string>;
  private readonly opts: ReplayOptions;
  private readonly pruneGate = new ReplayPruneGate();

  constructor(options: ReplayInstallerOptions) {
    const { engine, channelKey, exclude, opts } = options;
    this.engine = engine;
    this.channelKey = channelKey;
    this.exclude = exclude;
    this.opts = opts;
  }

  /** The rows this instance owns, for its retention prune. */
  owner = (): ReplayStoreOwner => ({
    channelKey: this.channelKey,
    claimedChannelKeys: this.engine.getReplayClaimedChannelKeys(),
  });

  /** Persist one broadcast to the replay table. */
  persist = (wireMessage: WireBroadcastMessage): void => {
    if (
      !shouldStoreReplayMessage(wireMessage.event, {
        channelKey: this.channelKey,
        livething: wireMessage.livething,
        exclude: this.exclude,
        claimedChannelKeys: this.engine.getReplayClaimedChannelKeys(),
      })
    )
      return;

    const { sql } = this.engine.storage;
    const scope = this.engine.getInvocationScope() as {
      pendingSnapshotFlushes: Map<string, ReplaySnapshotEntry>;
    } | null;
    // `replayScope` carries this frame's channel markers. For the row-count
    // limit, `channel`/`channelFamily` pick the store: there are two replay
    // stores (top-level and per-channel). `pruneReplayScopeRows` keys on
    // channel only.
    const replayScope = readReplayScope(wireMessage.livething);
    const retention = this.opts.retention;
    const owner = this.owner();

    function runPrune(sqlForPrune: Pick<SQLProvider, 'exec'>): void {
      pruneExpiredReplayRows(sqlForPrune, { retention, now: Date.now(), owner });
      pruneReplayScopeRows(sqlForPrune, retention, replayScope);
    }

    const row = persistReplayMessage(sql, {
      options: this.opts,
      event: wireMessage.event,
      payload: wireMessage.payload,
      livething: wireMessage.livething,
      userId: wireMessage.userId,
      now: Date.now(),
      scope,
      postFlush: runPrune,
      // A reducer can return any { event, payload }; the live send only checked
      // the original frame. Validate the reduced value here so the stored row
      // conforms to the contract and the replay-from-storage path stays trusted.
      validateReduced: this.opts.reduce
        ? (event, payload) =>
            this.engine.assertReplaySendContract(event, payload, {
              channel: replayScope.channel ?? undefined,
              channelFamily: replayScope.channelFamily,
            })
        : undefined,
    });

    // Only snapshot writes that ran inside an open handler scope get queued
    // for a later flush. Every other case (history mode, or snapshot mode
    // with no handler scope) has already saved the row to SQL above, so the
    // retention prune needs to run here and now — otherwise the table can
    // grow past its row limit before the next call cleans it up.
    //
    // For the queued case the scope flusher calls `runPrune` itself once
    // the row is actually on disk, so we deliberately skip the prune here.
    const isHistory = (this.opts.type ?? 'history') === 'history';
    const queued = scope !== null && !isHistory;
    if (!queued) {
      const stamp = row?.createdAt ?? Date.now();
      if (isHistory) {
        // History stores one new row per message, so the gate can count exactly
        // and skip the prune whenever the store is under its caps.
        this.pruneGate.prune(sql, { retention, scope: replayScope, owner, stamp });
      } else {
        pruneExpiredReplayRows(sql, { retention, now: stamp, owner });
        pruneReplayScopeRows(sql, retention, replayScope);
      }
    }
  };

  /** Handle the `__replay__` protocol frame by resending stored rows to the requester. */
  protocolHandler = async (
    ctx: unknown,
    frame: Protocol.IncomingProtocolFrame,
  ): Promise<boolean> => {
    if (frame.event !== '__replay__') return false;

    const scope = readReplayContextScope(ctx as Record<PropertyKey, unknown>);
    if (!matchesReplayScope(this.channelKey, scope, this.engine.getReplayClaimedChannelKeys())) {
      return false;
    }

    const connection = (ctx as Record<PropertyKey, unknown>)[ENGINE_INTERNAL_CONNECTION] as
      | RuntimeConnection
      | undefined;
    if (!isChannelReplayAuthorized(connection, scope, frame.__livething)) {
      // No rows and no error — don't reveal the channel to a non-member.
      return true;
    }

    const since = frame.payload.lastKnownSeq ?? 0;
    const { sql } = this.engine.storage;

    const connectionId = readConnectionId(ctx as Record<PropertyKey, unknown>);
    if (!connectionId) return true;

    // Snapshot resends current state, so only history mode can have a gap.
    // Detected against the eviction watermark, not MIN(seq): the global seq counter is sparse.
    if ((this.opts.type ?? 'history') === 'history' && since > 0) {
      const watermark = readReplayGapWatermark(
        sql,
        { channel: scope.channelName ?? null, channelFamily: scope.channelFamily ?? null },
        connection?.userId || null,
      );
      if (watermark !== null && since < watermark) {
        this.engine.sendGap(connectionId, {
          channelName: scope.channelName ?? null,
          channelFamily: scope.channelFamily ?? null,
          missedThrough: watermark,
        });
        if (connection?.closing) return true;
      }
    }

    const rows = loadReplayRows(sql, since, {
      channelName: scope.channelName,
      channelFamily: scope.channelFamily ?? null,
      userId: connection?.userId || null,
    });

    for (const row of rows) {
      const rowPayload = JSON.parse(row.payload) as Record<string, unknown>;
      this.engine.sendReplay(connectionId, {
        channelName: row.channel,
        channelFamily: row.channelFamily,
        event: row.event,
        payload: rowPayload,
        wire: {
          deliverySeq: row.seq,
          messageId: row.messageId,
          channel: row.channel ?? undefined,
        },
      });
      if (connection?.closing) return true;
    }

    return true;
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
replay.__key = REPLAY_KEY;
