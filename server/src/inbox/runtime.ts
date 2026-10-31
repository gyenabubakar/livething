import { rescheduleAlarm as rescheduleEngineAlarm } from '~/_engine/alarm.ts';
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
  listInboxRetentionTargets,
  listStoredInboxSeqs,
  loadInboxWatermarks,
  loadUndeliveredRows,
  nextInboxRetentionAt,
  pruneInboxRetentionAndBumpWatermark,
} from '~/inbox/storage.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SQLProvider } from '~/context.ts';
import type { InboxFrame, InboxRetention } from '~/inbox/storage.ts';

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

interface InboxFanOutOptions {
  channelName: string;
  channelFamily: string | null;
  event: string;
  payload: Record<string, unknown>;
  deliverySeq: number;
  messageId: string;
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

  insertInboxRows(sql, {
    userIds,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    frame,
    now: Date.now(),
  });

  if (config.retention) {
    // Only a row-count cap (no age cap) can be proven satisfied from the count
    // alone; an age cap still has to check timestamps every time.
    const cap = config.retention.maxMessages;
    const countGates = config.retention.maxAgeMs === undefined && cap !== undefined;

    for (const userId of userIds) {
      const key = memberCountKey(opts.channelName, opts.channelFamily, userId);
      const cached = core.inboxMemberCounts.get(key);
      const count =
        cached === undefined
          ? countInboxRows(sql, {
              userId,
              channelName: opts.channelName,
              channelFamily: opts.channelFamily,
            })
          : cached + 1;
      core.inboxMemberCounts.set(key, count);

      if (countGates && count <= cap!) continue;

      const evicted = applyInboxRetention(sql, {
        userId,
        channelName: opts.channelName,
        channelFamily: opts.channelFamily,
        retention: config.retention,
      });
      if (countGates && evicted !== null) core.inboxMemberCounts.set(key, cap!);
    }

    if (config.retention.maxAgeMs !== undefined) rescheduleEngineAlarm(core);
  }
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
  const maxAgeMs = params.retention.maxAgeMs;
  if (maxAgeMs === undefined && params.retention.maxMessages === undefined) return 0;

  // A count-only retention config has no alarm source, but it still needs a
  // boot pass so a deploy that lowers maxMessages enforces the new bound on
  // rows already on disk. Age-retained configs can use the narrower expired
  // query unless they also carry a count cap, whose bound may have changed.
  const targets =
    params.retention.maxMessages !== undefined
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
 */
export function drainInboxOnReconnect(core: EngineCore, connection: RuntimeConnection): void {
  if (!connection.userId) return;

  const { sql } = core.storage;

  const watermarks = loadInboxWatermarks(sql, connection.userId);
  for (const watermark of watermarks) {
    sendGap(core, connection, {
      channelName: watermark.channelName,
      channelFamily: watermark.channelFamily,
      missedThrough: watermark.evictedThroughSeq,
    });
    if (connection.closing) return;
  }

  const rows = loadUndeliveredRows(sql, connection.userId);
  if (rows.length === 0) return;

  for (const row of rows) {
    sendReplay(core, connection, {
      channelName: row.channelName,
      channelFamily: row.channelFamily,
      event: row.event,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      wire: {
        deliverySeq: row.seq,
        messageId: row.messageId,
        channel: row.channelName,
      },
    });
    if (connection.closing) return;
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
