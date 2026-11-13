/* oxlint-disable @typescript-eslint/no-explicit-any */
import { LiveThingConfigError } from '@livething/core';
import { closeSlowClient } from '~/_adapters/close.ts';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { seqScopeKey } from '~/_engine/runtime/catch-up-hold.ts';
import {
  CATCH_UP_PAGE,
  catchUpBufferIsHigh,
  catchUpDeadline,
  runCatchUp,
  waitForCatchUpBuffer,
} from '~/_engine/runtime/catch-up.ts';
import { assertOneOf, assertOptionalPositiveInteger } from '~/_engine/validation.ts';
import {
  dropQueuedReplaySnapshots,
  ensureReplaySchema,
  isChannelReplayAuthorized,
  loadReplayPage,
  matchesReplayScope,
  maxReplaySeq,
  persistReplayMessage,
  pruneExpiredReplayRows,
  pruneReplayScopeRows,
  purgeReplayUser,
  readReplayContextScope,
  readReplayGapWatermark,
  readReplayScope,
  replayAudiencesOfRequester,
  replayAudiencesOfRow,
  ReplayPruneGate,
  shouldStoreReplayMessage,
} from '~/replay/runtime.ts';
import { createSendReplayExtender, readConnectionId } from '~/replay/send-replay.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { StoredRowSkip } from '~/_engine/runtime/stored-row.ts';
import type {
  FrameRecipient,
  RuntimeConnection,
  WireBroadcastMessage,
} from '~/_engine/runtime/types.ts';
import type { SQLProvider } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReplaySnapshotEntry, ReplayStoreOwner } from '~/replay/runtime.ts';
import type { ReplayOptions, ReplayRow } from '~/replay/types.ts';

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

/** The default `retention.maxBytes` of one audience in one store. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

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
 *   broadcast) is recorded once, with the resume tokens of those connections.
 *   Each connection gets its secret token in `__connected__`. The frame replays
 *   only to a client that shows one of those tokens and has the same user (or
 *   is anonymous, when the connection was). `maxMessages` counts it once for
 *   each user and each anonymous token it reached.
 * - A broadcast that left out its sender replays to anyone but a client showing
 *   that sender's token. Another tab of the same user still gets it.
 * - Request replies, server requests and stream chunks are never recorded.
 * - A binary event is recorded like a JSON one, with its bytes, and replays as
 *   one binary frame. Only history mode stores binary events.
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

  if (options?.retention) {
    const { retention } = options;
    assertOptionalPositiveInteger(retention.maxAgeMs, 'retention.maxAgeMs', 'replay()');
    assertOptionalPositiveInteger(retention.maxMessages, 'retention.maxMessages', 'replay()');
    assertOptionalPositiveInteger(retention.maxBytes, 'retention.maxBytes', 'replay()');
  }

  const opts: ReplayOptions = {
    ...options,
    retention: {
      ...options?.retention,
      maxBytes: options?.retention?.maxBytes ?? DEFAULT_MAX_BYTES,
    },
  };

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
      if (opts.type === 'snapshot') assertNoSnapshotBinary(engine, channelKey, exclude);

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
          // The bytes are a view of the sender's buffer, which it may reuse once the send returns.
          const sent = message.bytes ? { ...message, bytes: message.bytes.slice() } : message;
          return Promise.resolve().then(() => {
            installer.persist(sent);
          });
        });
      }

      engine.onProtocolMessage('__replay__', installer.protocolHandler);
      engine.onPurgeUser((core, userId) => {
        dropQueuedReplaySnapshots(
          (core as EngineCore).pendingSnapshotFlushes as Map<string, ReplaySnapshotEntry>,
          userId,
        );
        purgeReplayUser(engine.storage.sql, userId);
      });
    },
  };
}

/**
 * A snapshot's `reduce` combines JSON values and has no way to combine bytes, so a snapshot store
 * cannot hold a binary event. Fail at startup instead of on the first send.
 */
function assertNoSnapshotBinary(
  engine: EngineAccess,
  channelKey: string | undefined,
  exclude: ReadonlySet<string>,
): void {
  const claimed = engine.getReplayClaimedChannelKeys();
  const stored = engine
    .getBinaryEvents()
    .find(
      (declared) =>
        !exclude.has(declared.event) &&
        (channelKey
          ? declared.channelKey === channelKey
          : declared.channelKey === undefined || !claimed.has(declared.channelKey)),
    );
  if (!stored) return;

  const where = stored.channelKey ? ` of channel '${stored.channelKey}'` : '';
  throw new LiveThingConfigError(
    `replay.snapshot() cannot store the binary event '${stored.event}'${where}: a snapshot ` +
      "cannot combine bytes. Use replay.history() (history mode), or list the event in the replay's " +
      '`exclude`.',
  );
}

/** Who one stored row is for: one user, or the chosen connections a frame was sent to. */
interface ReplayRowAudience {
  userId?: string;
  recipients?: readonly FrameRecipient[];
  excludedToken?: string;
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
  private readonly warnedTooBig = new Set<string>();

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

  /**
   * Persist one outgoing frame. In history mode that is one row, plus one recipient row per
   * connection when it went to chosen ones. In snapshot mode each user or anonymous token keeps
   * its own current value, so it is one row for each.
   */
  persist = (wireMessage: WireBroadcastMessage): void => {
    if (
      !shouldStoreReplayMessage(wireMessage.event, {
        channelKey: this.channelKey,
        livething: wireMessage.livething,
        exclude: this.exclude,
        claimedChannelKeys: this.engine.getReplayClaimedChannelKeys(),
      })
    ) {
      return;
    }

    const isSnapshot = (this.opts.type ?? 'history') === 'snapshot';
    if (!wireMessage.recipients) {
      this.persistRow(wireMessage, {
        userId: wireMessage.userId,
        // A snapshot is the current value, so even the sender it left out reads it on replay.
        excludedToken: isSnapshot ? undefined : wireMessage.excludedResumeToken,
      });
      return;
    }

    const recipients = wireMessage.recipients.filter(
      (recipient) => !(recipient.userId && this.engine.isUserPurging?.(recipient.userId)),
    );
    if (recipients.length === 0) return;

    const audiences: ReplayRowAudience[] = [];
    if (isSnapshot) {
      // A snapshot is the user's current value, so a new connection of that user reads it as-is.
      for (const userId of new Set(recipients.map((recipient) => recipient.userId))) {
        if (userId) audiences.push({ userId });
      }

      // An anonymous connection has only its token, so each token keeps its own current value.
      for (const recipient of recipients) {
        if (!recipient.userId) audiences.push({ recipients: [recipient] });
      }
    } else {
      audiences.push({ recipients });
    }

    // A strict send that fails on one row must keep none: SQL rows roll back with the
    // transaction, and snapshot rows queued in the handler scope are put back by hand.
    const queue = this.snapshotQueue();
    const queuedBefore = queue && new Map(queue);
    const writeAll = (): void => {
      for (const audience of audiences) this.persistRow(wireMessage, audience);
    };
    try {
      // A Cloudflare transaction costs extra queries, so a user's one snapshot row skips it.
      if (audiences.length > 1 || audiences[0]?.recipients) {
        this.engine.storage.sql.transaction(writeAll);
      } else {
        writeAll();
      }
    } catch (error) {
      if (queue && queuedBefore) {
        queue.clear();
        for (const [key, entry] of queuedBefore) queue.set(key, entry);
      }

      throw error;
    }
  };

  /** Warn once per event that replay could not store a message over the storage row limit. */
  private warnRowTooBig = (row: ReplayRow, skip: StoredRowSkip): void => {
    const key = JSON.stringify([row.event, skip.limit]);
    if (this.warnedTooBig.has(key)) return;

    this.warnedTooBig.add(key);
    const limit = SKIPPED_ROW_LIMITS[skip.limit];
    this.engine
      .getLogger?.()
      ?.warn(
        `[livething] replay did not store "${row.event}" because the message is over ${limit} ` +
          `of ${skip.bytes} bytes. A client that reconnects does not get it back. This warning ` +
          'shows once for each event and limit.',
        { event: row.event, rowBytes: row.rowBytes },
      );
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
    if (audience.userId && this.engine.isUserPurging?.(audience.userId)) return;

    const { sql } = this.engine.storage;
    const scope = this.engine.getInvocationScope() as {
      pendingSnapshotFlushes: Map<string, ReplaySnapshotEntry>;
    } | null;
    // `replayScope` carries this frame's channel markers. For the row-count
    // limit, `channel`/`channelFamily` pick the store (top level or one channel)
    // and `audience` picks the budget inside it.
    const replayScope = readReplayScope(wireMessage.livething);
    const audienceScopes = replayAudiencesOfRow(audience.userId, audience.recipients).map(
      (replayAudience) => ({ ...replayScope, audience: replayAudience }),
    );

    const retention = this.opts.retention;
    const owner = this.owner();
    const { pruneGate } = this;

    function pruneSnapshotRows(
      sqlForPrune: Pick<SQLProvider, 'exec' | 'limits'>,
      now: number,
      rowBytes: number,
    ): void {
      pruneExpiredReplayRows(sqlForPrune, { retention, now, owner });
      for (const one of audienceScopes) pruneReplayScopeRows(sqlForPrune, retention, one);
      pruneGate.pruneBytes(sqlForPrune, { retention, scopes: audienceScopes, rowBytes });
      pruneGate.pruneAnonymousTotal(sqlForPrune, { retention, scopes: audienceScopes, rowBytes });
    }

    function runPrune(sqlForPrune: Pick<SQLProvider, 'exec' | 'limits'>, rowBytes: number): void {
      pruneSnapshotRows(sqlForPrune, Date.now(), rowBytes);
    }

    const row = persistReplayMessage(sql, {
      options: this.opts,
      event: wireMessage.event,
      payload: wireMessage.payload,
      bytes: wireMessage.bytes,
      livething: wireMessage.livething,
      userId: audience.userId,
      recipients: audience.recipients,
      excludedToken: audience.excludedToken,
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
      onRowTooBig: this.warnRowTooBig,
      sendBytes: this.engine.getMessageLimits().sendBytes,
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
        this.pruneGate.prune(sql, {
          retention,
          scopes: audienceScopes,
          owner,
          stamp,
          rowBytes: row?.rowBytes ?? 0,
        });
      } else {
        pruneSnapshotRows(sql, stamp, row?.rowBytes ?? 0);
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

    const connectionId = readConnectionId(ctx as Record<PropertyKey, unknown>);
    if (!connectionId) return true;

    const request: CatchUpRequest = {
      connectionId,
      connection,
      scope,
      since: frame.payload.lastKnownSeq ?? 0,
      resumeTokens: frame.payload.resume ?? [],
    };

    if (!connection) {
      await this.catchUp(request);
      return true;
    }

    const storeKey = seqScopeKey(scope.channelName ?? null, scope.channelFamily ?? null);
    await runCatchUp(connection, [storeKey], () => this.catchUp(request));

    return true;
  };

  /**
   * Send a `__gap__` when the client is behind the watermark, then every row it missed, in seq
   * order. The rows are read a page at a time, so one catch-up holds at most a page in memory.
   * Rows stored after it starts are left out: their live frames are held, and go out after it.
   */
  private async catchUp(request: CatchUpRequest): Promise<void> {
    const { connectionId, connection, scope, resumeTokens } = request;
    const { sql } = this.engine.storage;
    const loadScope = {
      channelName: scope.channelName,
      channelFamily: scope.channelFamily ?? null,
      userId: connection?.userId || null,
      resumeTokens,
    };

    const page = { throughSeq: maxReplaySeq(sql), ...CATCH_UP_PAGE };

    if (this.sendGapIfBehind(request, request.since) && connection?.closing) return;

    let cursor = request.since;
    let rows = loadReplayPage(sql, loadScope, { ...page, since: cursor });
    let next = 0;
    // One budget for every wait of this catch-up, so a client that stops reading is closed
    // after about 50 seconds, however many rows are left.
    const waitUntil = catchUpDeadline();
    while (next < rows.length) {
      if (connection && catchUpBufferIsHigh(connection)) {
        if (!(await waitForCatchUpBuffer(connection, waitUntil))) {
          // The client reconnects and asks again from where it got to.
          if (!connection.closing) closeSlowClient(connection.descriptor);
          return;
        }

        if (connection.closing) return;

        // Retention can delete rows while the catch-up waits, so read again from the cursor.
        // The client gets a gap for deleted rows, as it would have before the catch-up started.
        if (this.sendGapIfBehind(request, cursor, page.throughSeq) && connection.closing) return;

        rows = loadReplayPage(sql, loadScope, { ...page, since: cursor });
        next = 0;
        if (rows.length === 0) return;
      }

      const row = rows[next]!;
      next += 1;
      this.engine.sendReplay(connectionId, {
        channelName: row.channel,
        channelFamily: row.channelFamily,
        event: row.event,
        payload: JSON.parse(row.payload) as Record<string, unknown> | null,
        bytes: row.binaryPayload ?? undefined,
        wire: {
          deliverySeq: row.seq,
          messageId: row.messageId,
          channel: row.channel ?? undefined,
        },
      });
      if (connection?.closing) return;

      cursor = row.seq;
      if (next === rows.length) {
        rows = loadReplayPage(sql, loadScope, { ...page, since: cursor });
        next = 0;
      }
    }
  }

  /**
   * Send a `__gap__` when rows after `cursor` the client could have had were deleted. The
   * request remembers the gap it sent, so a later check never sends the same one again.
   */
  private sendGapIfBehind(
    request: CatchUpRequest,
    sentThrough: number,
    coveredThrough = Infinity,
  ): boolean {
    const cursor = Math.max(sentThrough, request.gapThrough ?? 0);
    const { connectionId, connection, scope, resumeTokens } = request;
    // Snapshot resends current state, so only history mode can have a gap. A client at 0 has
    // seen nothing, so it cannot be behind.
    if ((this.opts.type ?? 'history') !== 'history' || cursor <= 0) return false;

    // Detected against the eviction watermark, not MIN(seq): the global seq counter is sparse.
    const evicted = readReplayGapWatermark(
      this.engine.storage.sql,
      { channel: scope.channelName ?? null, channelFamily: scope.channelFamily ?? null },
      replayAudiencesOfRequester(connection?.userId || null, resumeTokens),
    );
    // During a catch-up, a deleted row newer than the rows it covers was held as a live frame,
    // so the client still gets it. Only the covered rows can be missed.
    const watermark = evicted === null ? null : Math.min(evicted, coveredThrough);
    if (watermark === null || cursor >= watermark) return false;

    this.engine.sendGap(connectionId, {
      channelName: scope.channelName ?? null,
      channelFamily: scope.channelFamily ?? null,
      missedThrough: watermark,
    });
    request.gapThrough = watermark;

    return true;
  }
}

interface CatchUpRequest {
  connectionId: string;
  connection: RuntimeConnection | undefined;
  scope: EngineChannelMeta;
  since: number;
  resumeTokens: readonly string[];
  /** The `missedThrough` of the last `__gap__` this catch-up sent. */
  gapThrough?: number;
}

/** How each limit that keeps a row out of replay is named in the warning. */
const SKIPPED_ROW_LIMITS: Record<StoredRowSkip['limit'], string> = {
  storage: 'the storage row limit',
  send: 'the send limit',
  retention: 'retention.maxBytes',
};
