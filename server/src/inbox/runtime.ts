import { closeSlowClient } from '~/_adapters/close.ts';
import { rescheduleAlarm as rescheduleEngineAlarm } from '~/_engine/alarm.ts';
import { seqScopeKey } from '~/_engine/runtime/catch-up-hold.ts';
import {
  CATCH_UP_PAGE,
  catchUpBufferIsHigh,
  catchUpDeadline,
  runCatchUp,
  waitForCatchUpBuffer,
} from '~/_engine/runtime/catch-up.ts';
import {
  storedRowBytes,
  storedRowSkip,
  storedRowStorageBytes,
} from '~/_engine/runtime/stored-row.ts';
import { sendGap, sendReplay } from '~/_engine/runtime/wire.ts';
import { listIdentitiesByChannel } from '~/channel/storage.ts';
import {
  ackInboxRows,
  clearInboxWatermarkThrough,
  countInboxRows,
  deleteInboxRowsForChannel,
  deleteInboxWatermarkForChannel,
  insertInboxRows,
  insertInboxRowsForUserId,
  listExpiredInboxRetentionTargets,
  listInboxChannelsOf,
  listInboxRetentionTargets,
  listStoredInboxSeqs,
  loadInboxWatermarks,
  loadUndeliveredRows,
  nextInboxRetentionAt,
  pruneInboxRetentionAndBumpWatermark,
} from '~/inbox/storage.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { StoredRowLimits, StoredRowSkip } from '~/_engine/runtime/stored-row.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SQLProvider } from '~/context.ts';
import type { InboxFrame, InboxRetention, InboxRow } from '~/inbox/storage.ts';

/**
 * Whether an engine channel scope belongs to the given channel key (channel
 * name for a static channel, family key for a dynamic family). Shared by
 * `inbox()` and `readReceipts()` to gate their wire handlers and context
 * extenders to their own channel.
 */
export function scopeMatchesChannel(
  scope: EngineChannelMeta | undefined,
  channelKey: string,
): boolean {
  const scopeKey = scope?.channelFamily ?? scope?.channelName;
  return scopeKey === channelKey;
}

/**
 * The default member cap for the live delivered/read receipt fan-out. Above it
 * the cursor is still stored and stays queryable, but the live tick is
 * suppressed because its fan-out is O(members²). Shared by inbox's `__received__`
 * tick and the read-receipts `__read__` tick.
 */
export const DEFAULT_MAX_RECEIPT_AUDIENCE = 256;

interface InboxMessage {
  channelName: string;
  channelFamily: string | null;
  event: string;
  payload: Record<string, unknown> | null;
  /** The bytes of a binary event. */
  bytes?: Uint8Array;
  messageId: string;
}

interface InboxFanOutOptions extends InboxMessage {
  deliverySeq: number;
  excludeUserId?: string;
  /** A user `purgeUser` is wiping gets no new row. */
  isUserPurging?: (userId: string) => boolean;
}

interface InboxRetentionDeadlineOptions {
  channelKey: string;
  maxAgeMs: number;
}

interface InboxRetentionSweepOptions {
  channelKey: string;
  retention: InboxRetention;
  now: number;
}

interface InboxAckOptions {
  userId: string;
  channelName: string;
  channelFamily: string | null;
  receivedThrough: number;
}

interface InboxMemberKey {
  userId: string;
  channelName: string;
  channelFamily: string | null;
}

interface InboxBackfillOptions extends InboxMemberKey {
  frames: readonly InboxFrame[];
  retention?: InboxRetention;
}

interface InboxRetentionApplyOptions extends Omit<InboxMemberKey, 'userId'> {
  userId: string;
  retention: InboxRetention;
}

/** Resolve the channel key (family key for families, name for static channels). */
export function channelKeyFor(channelName: string, channelFamily: string | null): string {
  return channelFamily ?? channelName;
}

/**
 * Fan one logical channel message out to every durable member's inbox, keyed on
 * the `deliverySeq`/`messageId` the broadcast already stamped, so a member's inbox row
 * matches the live frame it also receives (its ack settles the row, and dedup
 * suppresses the reconnect re-delivery). A no-op for a channel without inbox.
 * Anonymous members (empty user id) hold no durable row and get live-only
 * delivery, but still see the same shared deliverySeq/messageId on the live frame.
 *
 * `excludeUserId`, when set, skips that member's row entirely — used when the
 * broadcast excluded their one and only connection in this channel, so they
 * will never receive (and so never acknowledge) the live frame. A user with a
 * second, still-included connection in the channel is never passed here, and
 * gets its row as normal.
 */
export function fanOutToInbox(core: EngineCore, opts: InboxFanOutOptions): void {
  const config = core.inboxChannels.get(channelKeyFor(opts.channelName, opts.channelFamily));
  if (!config) return;

  const { sql } = core.storage;
  const userIds = listIdentitiesByChannel(sql, opts.channelName, opts.channelFamily).filter(
    (userId) => userId !== '' && userId !== opts.excludeUserId && !opts.isUserPurging?.(userId),
  );
  if (userIds.length === 0) return;

  const frame: InboxFrame = {
    deliverySeq: opts.deliverySeq,
    messageId: opts.messageId,
    event: opts.event,
    payload: opts.payload,
  };

  if (opts.bytes !== undefined) frame.bytes = opts.bytes;

  insertInboxRows(sql, {
    userIds,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    frame,
    now: Date.now(),
  });

  const { retention } = config;
  if (!retention) return;

  const rowBytes = storedRowBytes(JSON.stringify(opts.payload), opts.bytes);
  for (const userId of userIds) {
    const key = memberCountKey(opts.channelName, opts.channelFamily, userId);
    const cached = core.inboxMemberCounts.get(key);
    const held = cached
      ? { rows: cached.rows + 1, bytes: cached.bytes + rowBytes }
      : countInboxRows(sql, {
          userId,
          channelName: opts.channelName,
          channelFamily: opts.channelFamily,
        });
    core.inboxMemberCounts.set(key, held);

    // Only the count and byte caps can be proven met from the cache; an age cap still has to
    // check timestamps every time.
    const overCap =
      retention.maxAgeMs !== undefined ||
      (retention.maxMessages !== undefined && held.rows > retention.maxMessages) ||
      (retention.maxBytes !== undefined && held.bytes > retention.maxBytes);
    if (!overCap) continue;

    const evicted = applyInboxRetention(sql, {
      userId,
      channelName: opts.channelName,
      channelFamily: opts.channelFamily,
      retention,
    });
    // The next write counts again from storage.
    if (evicted !== null) core.inboxMemberCounts.delete(key);
  }

  if (retention.maxAgeMs !== undefined) rescheduleEngineAlarm(core);
}

/** The errors already logged for a message the inbox could not store, once per event and limit. */
const refusalsLogged = new WeakMap<EngineCore, Set<string>>();

/** How each limit that keeps a message out of an inbox is named in the error. */
const REFUSAL_LIMITS: Record<StoredRowSkip['limit'], string> = {
  storage: 'the storage row limit',
  send: 'the send limit',
  retention: 'retention.maxBytes',
};

/**
 * Whether the inbox of a channel can store this message for each member. An inbox promises
 * every member every message, so a message it cannot store goes to nobody: sending it live
 * only would break that promise with no sign. Then LiveThing logs an error, once for each
 * event and limit. Channels without `inbox()` can store anything.
 */
export function inboxCanStore(core: EngineCore, message: InboxMessage): boolean {
  const channelKey = channelKeyFor(message.channelName, message.channelFamily);
  const config = core.inboxChannels.get(channelKey);
  if (!config) return true;

  const tooBig = inboxRowTooBig(message, {
    maxValueBytes: core.storage.sql.limits.maxValueBytes,
    sendBytes: core.messageLimits.sendBytes,
    maxBytes: config.retention?.maxBytes,
  });
  if (!tooBig) return true;

  let logged = refusalsLogged.get(core);
  if (!logged) refusalsLogged.set(core, (logged = new Set()));

  const key = JSON.stringify([channelKey, message.event, tooBig.skip.limit]);
  if (!logged.has(key)) {
    logged.add(key);
    core.logger.error(
      `[livething] channel '${message.channelName}' did not send ${tooBig.reason}, and no ` +
        'member got it. This error shows once for each event and limit.',
      { channel: message.channelName, event: message.event, rowBytes: tooBig.rowBytes },
    );
  }

  return false;
}

/** Why an inbox cannot store a message, said for an error message. */
interface InboxRowTooBig {
  skip: StoredRowSkip;
  rowBytes: number;
  /** For example `"voice-note": the message is over the send limit of … bytes, so …`. */
  reason: string;
}

/** Why one member's row of this message would be over a limit, or `null` when it fits. */
export function inboxRowTooBig(
  message: InboxMessage,
  limits: StoredRowLimits,
): InboxRowTooBig | null {
  const rowBytes = storedRowBytes(JSON.stringify(message.payload), message.bytes);
  // The member's user id is not counted: the limit has room to spare for it.
  const columns = [message.channelName, message.channelFamily, message.messageId, message.event];
  const skip = storedRowSkip(
    { storageBytes: storedRowStorageBytes(rowBytes, columns), rowBytes },
    limits,
  );
  if (!skip) return null;

  return {
    skip,
    rowBytes,
    reason:
      `"${message.event}": the message is over ${REFUSAL_LIMITS[skip.limit]} of ${skip.bytes} ` +
      'bytes, so its inbox cannot store it',
  };
}

/** Return the next age-retention deadline for one static channel or family. */
export function nextInboxRetentionDeadline(
  sql: Pick<SQLProvider, 'exec'>,
  params: InboxRetentionDeadlineOptions,
): number | null {
  return nextInboxRetentionAt(sql, params);
}

/**
 * Prune all expired rows in one inbox channel key. A family key may contain
 * many concrete channel names, so storage returns each concrete member scope
 * and every prune keeps its own watermark transactionally paired with deletes.
 */
export function sweepInboxRetention(
  sql: Pick<SQLProvider, 'exec' | 'transaction'>,
  params: InboxRetentionSweepOptions,
): number {
  const { maxAgeMs, maxMessages, maxBytes } = params.retention;
  const capsSize = maxMessages !== undefined || maxBytes !== undefined;
  if (maxAgeMs === undefined && !capsSize) return 0;

  // A count or byte retention config has no alarm source, but it still needs a
  // boot pass so a deploy that lowers maxMessages or maxBytes enforces the new
  // bound on rows already on disk. Age-retained configs can use the narrower
  // expired query unless they also carry a count or byte cap, whose bound may
  // have changed.
  const targets = capsSize
    ? listInboxRetentionTargets(sql, { channelKey: params.channelKey })
    : listExpiredInboxRetentionTargets(sql, {
        channelKey: params.channelKey,
        maxAgeMs: maxAgeMs!,
        now: params.now,
      });
  let pruned = 0;
  for (const target of targets) {
    if (
      pruneInboxRetentionAndBumpWatermark(sql, {
        ...target,
        retention: params.retention,
        now: params.now,
      }) !== null
    ) {
      pruned += 1;
    }
  }

  return pruned;
}

/** Cache key for a member's per-channel inbox row count. */
export function memberCountKey(
  channelName: string,
  channelFamily: string | null,
  userId: string,
): string {
  return JSON.stringify([channelName, channelFamily, userId]);
}

/**
 * Re-deliver a reconnecting member's owed rows in seq order across every channel
 * it belongs to. Rows are not deleted on send — the client acks with
 * `__received__`, and that ack settles them.
 *
 * The rows go out a page at a time, and the drain waits while the socket's buffer is high,
 * the same way a replay catch-up does: live frames of those channels wait until the drain
 * ends, and a member that reads nothing for about 50 seconds is closed with `1013`. It
 * returns as soon as it has to wait, so the connection's other work goes on meanwhile.
 */
export async function drainInboxOnReconnect(
  core: EngineCore,
  connection: RuntimeConnection,
): Promise<void> {
  const { userId } = connection;
  if (!userId) return;

  const { sql } = core.storage;
  const owed = listInboxChannelsOf(sql, userId);
  const channels = [...owed, ...loadInboxWatermarks(sql, userId)];
  if (channels.length === 0) return;

  // A row stored after the drain starts has its live frame held, and that frame goes out
  // after the drain, so the drain leaves the row out.
  const throughSeq = Math.max(0, ...owed.map((channel) => channel.maxSeq));
  const storeKeys = new Set(
    channels.map((channel) => seqScopeKey(channel.channelName, channel.channelFamily)),
  );
  await runCatchUp(connection, [...storeKeys], () =>
    sendOwedRows(core, connection, { userId, throughSeq }),
  );
}

/** Whose rows a drain sends, and the highest seq it sends. */
interface OwedRows {
  userId: string;
  throughSeq: number;
}

/** The highest seq a drain has covered in each channel, with a row or with a `__gap__`. */
type DrainCovered = Map<string, number>;

/** Send every owed row of a member, a page at a time, waiting while the buffer is high. */
async function sendOwedRows(
  core: EngineCore,
  connection: RuntimeConnection,
  owed: OwedRows,
): Promise<void> {
  const { userId, throughSeq } = owed;
  const { sql } = core.storage;
  const covered: DrainCovered = new Map();
  sendNewGaps(core, connection, covered);
  if (connection.closing) return;

  const waitUntil = catchUpDeadline();
  let after: InboxRow | undefined;
  for (;;) {
    const rows = loadUndeliveredRows(sql, userId, { after, ...CATCH_UP_PAGE });
    if (rows.length === 0) return;

    for (const row of rows) {
      // Stored after the drain started: its live frame is held, and goes out after the drain.
      if (row.seq > throughSeq) {
        after = row;
        continue;
      }

      if (catchUpBufferIsHigh(connection)) {
        if (!(await waitForCatchUpBuffer(connection, waitUntil))) {
          // The member reconnects, and the drain starts again from its first owed row.
          if (!connection.closing) closeSlowClient(connection.descriptor);
          return;
        }

        if (connection.closing) return;

        // Retention can delete rows while the drain waits: tell the member, then read again
        // from the last row sent. An ack can delete rows too, and those are no longer owed.
        sendNewGaps(core, connection, covered);
        if (connection.closing) return;

        break;
      }

      sendReplay(core, connection, {
        channelName: row.channelName,
        channelFamily: row.channelFamily,
        event: row.event,
        payload: JSON.parse(row.payload) as Record<string, unknown> | null,
        bytes: row.binaryPayload ?? undefined,
        wire: { deliverySeq: row.seq, messageId: row.messageId, channel: row.channelName },
      });
      if (connection.closing) return;

      after = row;
      covered.set(seqScopeKey(row.channelName, row.channelFamily), row.seq);
    }
  }
}

/** Send a `__gap__` for each overflow watermark above what the drain has covered in its channel. */
function sendNewGaps(core: EngineCore, connection: RuntimeConnection, covered: DrainCovered): void {
  for (const watermark of loadInboxWatermarks(core.storage.sql, connection.userId)) {
    const key = seqScopeKey(watermark.channelName, watermark.channelFamily);
    if (watermark.evictedThroughSeq <= (covered.get(key) ?? 0)) continue;

    sendGap(core, connection, {
      channelName: watermark.channelName,
      channelFamily: watermark.channelFamily,
      missedThrough: watermark.evictedThroughSeq,
    });
    if (connection.closing) return;

    covered.set(key, watermark.evictedThroughSeq);
  }
}

/** Apply a member's `__received__` ack: delete rows up to `receivedThrough`. */
export function applyInboxAck(sql: Pick<SQLProvider, 'exec'>, opts: InboxAckOptions): void {
  ackInboxRows(sql, opts);
  clearInboxWatermarkThrough(sql, opts);
}

/** Drop a member's rows for a channel it has left. */
export function clearInboxForChannel(core: EngineCore, key: InboxMemberKey): void {
  if (!key.userId) return;

  if (!core.inboxChannels.has(channelKeyFor(key.channelName, key.channelFamily))) return;

  const { sql } = core.storage;
  const { userId } = key;
  deleteInboxRowsForChannel(sql, {
    userId,
    channelName: key.channelName,
    channelFamily: key.channelFamily,
  });

  deleteInboxWatermarkForChannel(sql, {
    userId,
    channelName: key.channelName,
    channelFamily: key.channelFamily,
  });
  core.inboxMemberCounts.delete(memberCountKey(key.channelName, key.channelFamily, userId));
  rescheduleEngineAlarm(core);
}

/**
 * Back a user's inbox from a set of full frames whose seqs the caller took from
 * the server's sequence counter, in seq order. Returns the frames that are now
 * stored, in seq order: not the ones skipped because the member already held
 * that message id, and not the ones retention pruned straight away.
 *
 * Runs the inserted rows through the same retention and overflow-watermark
 * path `fanOutToInbox` uses, so a backfill that pushes a member over its
 * channel's retention cap prunes the same way a live message would, and a
 * member who falls behind because of it still gets a gap on its next drain.
 */
export function backfillInbox(
  sql: Pick<SQLProvider, 'exec' | 'transaction' | 'limits'>,
  opts: InboxBackfillOptions,
): InboxFrame[] {
  if (!opts.userId) return [];

  if (opts.frames.length === 0) return [];

  const scope = {
    userId: opts.userId,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
  };

  insertInboxRowsForUserId(sql, { ...scope, frames: opts.frames, now: Date.now() });

  if (opts.retention) applyInboxRetention(sql, { ...scope, retention: opts.retention });

  // The seqs are fresh from the counter, so any of them still stored is a row this call wrote.
  const stored = listStoredInboxSeqs(sql, {
    ...scope,
    fromSeq: opts.frames[0]!.deliverySeq,
    toSeq: opts.frames.at(-1)!.deliverySeq,
  });

  return opts.frames.filter((frame) => stored.has(frame.deliverySeq));
}

/**
 * Prune a member's channel rows past its retention limits and, if a row was
 * evicted, raise its overflow watermark so a later drain turns that loss into a
 * gap. The deletes and watermark write happen in one transaction.
 * Shared by the live fan-out path and `backfillInbox` so both enforce retention
 * the same way. Returns the highest evicted seq, or `null` when nothing was pruned.
 */
function applyInboxRetention(
  sql: Pick<SQLProvider, 'exec' | 'transaction'>,
  opts: InboxRetentionApplyOptions,
): number | null {
  return pruneInboxRetentionAndBumpWatermark(sql, {
    userId: opts.userId,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    retention: opts.retention,
    now: Date.now(),
  });
}
