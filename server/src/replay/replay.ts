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
  purgeReplayUser,
  readReplayContextScope,
  readReplayGapWatermark,
  readReplayScope,
  replayAudienceOf,
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

/** The primitive type produced by `replay.history()` and `replay.snapshot()`. */
export interface ReplayPrimitive extends Primitive<'replay'> {
  /**
   * `true` when the developer registered `replay(false)` to opt out of cascade
   * for this scope. Disabled primitives carry no setup work; they only exist to
   * appear in the compile-time claimed-scope map so server-level replay knows
   * to skip this scope.
   */
  readonly disabled?: boolean;
}

/** Unique symbol used to enforce one replay registration per handler scope. */
const REPLAY_KEY = Symbol('replay');

/**
 * Enables message replay. The server records every message it sends so
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
 * - A send to chosen connections (`ctx.send`, `ctx.connections.get(ref).send`,
 *   `ctx.channel.send`, `broadcastTo` a connection, tag or group, and a tag
 *   broadcast) is recorded once per user it reached, under the resume tokens of
 *   those connections. Each connection gets its secret token in `__resume__`.
 *   The frame replays only to a client that shows one of those tokens and has
 *   the same user (or is anonymous, when the connection was).
 * - Request replies, server requests and stream chunks are never recorded.
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
      __identity: [REPLAY_KEY],
      __requires: {},
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
    __identity: [REPLAY_KEY],
    __requires: {},
    __requiresCapabilities: [CAPABILITY_KIND.dedup, CAPABILITY_KIND.sequence],
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
      engine.onPurgeUser((_core, userId) => purgeReplayUser(engine.storage.sql, userId));
    },
  };
}

/** Who one stored row is for: one user, and, for a frame sent to chosen connections, their tokens. */
interface ReplayRowAudience {
  userId: string | undefined;
  recipients?: readonly string[];
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

  /** Persist one outgoing frame to the replay table: one row per user it was addressed to. */
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

    if (!wireMessage.recipients) {
      this.persistRow(wireMessage, { userId: wireMessage.userId });
      return;
    }

    const tokensByUser = new Map<string, string[]>();
    for (const { userId, resumeToken } of wireMessage.recipients) {
      const tokens = tokensByUser.get(userId);
      if (tokens) tokens.push(resumeToken);
      else tokensByUser.set(userId, [resumeToken]);
    }

    const isSnapshot = (this.opts.type ?? 'history') === 'snapshot';
    const audiences: ReplayRowAudience[] = [];
    for (const [userId, recipients] of tokensByUser) {
      if (!isSnapshot) {
        audiences.push({ userId, recipients });
      } else if (userId) {
        // A snapshot is the user's current value, so a new connection of that user reads it as-is.
        audiences.push({ userId });
      } else {
        // An anonymous connection has only its token, so each token keeps its own current value.
        for (const token of recipients) audiences.push({ userId, recipients: [token] });
      }
    }

    // A strict send that fails on one row must keep none: SQL rows roll back with the
    // transaction, and snapshot rows queued in the handler scope are put back by hand.
    const queue = this.snapshotQueue();
    const queuedBefore = queue && new Map(queue);
    const writeAll = (): void => {
      for (const audience of audiences) this.persistRow(wireMessage, audience);
    };
    try {
      // A Cloudflare transaction costs extra queries, so one row is written without one.
      if (audiences.length > 1) this.engine.storage.sql.transaction(writeAll);
      else writeAll();
    } catch (error) {
      if (queue && queuedBefore) {
        queue.clear();
        for (const [key, entry] of queuedBefore) queue.set(key, entry);
      }

      throw error;
    }
  };

  /** The open handler scope's snapshot queue, when snapshot rows are queued instead of written. */
  private snapshotQueue(): Map<string, ReplaySnapshotEntry> | undefined {
    if ((this.opts.type ?? 'history') !== 'snapshot') return undefined;

    const scope = this.engine.getInvocationScope() as {
      pendingSnapshotFlushes: Map<string, ReplaySnapshotEntry>;
    } | null;
    return scope?.pendingSnapshotFlushes;
  }

  private persistRow(wireMessage: WireBroadcastMessage, audience: ReplayRowAudience): void {
    const { sql } = this.engine.storage;
    const scope = this.engine.getInvocationScope() as {
      pendingSnapshotFlushes: Map<string, ReplaySnapshotEntry>;
    } | null;
    // `replayScope` carries this frame's channel markers. For the row-count
    // limit, `channel`/`channelFamily` pick the store (top level or one channel)
    // and `audience` picks the budget inside it.
    const replayScope = readReplayScope(wireMessage.livething);
    const audienceScope = {
      ...replayScope,
      audience: replayAudienceOf(audience.userId || null, audience.recipients !== undefined),
    };

    const retention = this.opts.retention;
    const owner = this.owner();

    function runPrune(sqlForPrune: Pick<SQLProvider, 'exec' | 'limits'>): void {
      pruneExpiredReplayRows(sqlForPrune, { retention, now: Date.now(), owner });
      pruneReplayScopeRows(sqlForPrune, retention, audienceScope);
    }

    const row = persistReplayMessage(sql, {
      options: this.opts,
      event: wireMessage.event,
      payload: wireMessage.payload,
      livething: wireMessage.livething,
      userId: audience.userId,
      recipients: audience.recipients,
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
        this.pruneGate.prune(sql, { retention, scope: audienceScope, owner, stamp });
      } else {
        pruneExpiredReplayRows(sql, { retention, now: stamp, owner });
        pruneReplayScopeRows(sql, retention, audienceScope);
      }
    }
  }

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
    const resumeTokens = frame.payload.resume ?? [];
    if ((this.opts.type ?? 'history') === 'history' && since > 0) {
      // An anonymous client has rows of its own only when it shows a resume token.
      const userId = connection?.userId || null;
      const watermark = readReplayGapWatermark(
        sql,
        { channel: scope.channelName ?? null, channelFamily: scope.channelFamily ?? null },
        userId || resumeTokens.length > 0 ? replayAudienceOf(userId, true) : null,
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
      resumeTokens,
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
