import { sendGap, sendReplay } from '~/_engine/runtime/wire.ts';
import { listIdentitiesByChannel } from '~/channel/storage.ts';
import {
  ackInboxRows,
  bumpInboxWatermark,
  clearInboxWatermarkThrough,
  countInboxRows,
  deleteInboxRowsForChannel,
  deleteInboxWatermarkForChannel,
  insertInboxRows,
  insertInboxRowsForUserId,
  loadInboxWatermarks,
  loadUndeliveredRows,
  pruneInboxRetention,
} from '~/inbox/storage.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { ResolvedInboxOptions } from '~/_engine/runtime/feature-slots.ts';
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

/** Resolve the channel key (family key for families, name for static channels). */
export function channelKeyFor(channelName: string, channelFamily: string | null): string {
  return channelFamily ?? channelName;
}

/**
 * Fan one logical channel message out to every durable member's inbox, keyed on
 * the `seq`/`messageId` the broadcast already stamped, so a member's inbox row
 * matches the live frame it also receives (its ack settles the row, and dedup
 * suppresses the reconnect re-delivery). A no-op for a channel without inbox.
 * Anonymous members (empty user id) hold no durable row and get live-only
 * delivery, but still see the same shared seq/messageId on the live frame.
 *
 * `excludeUserId`, when set, skips that member's row entirely — used when the
 * broadcast excluded their one and only connection in this channel, so they
 * will never receive (and so never acknowledge) the live frame. A user with a
 * second, still-included connection in the channel is never passed here, and
 * gets its row as normal.
 */
export function fanOutToInbox(
  core: EngineCore,
  opts: {
    channelName: string;
    channelFamily: string | null;
    event: string;
    payload: Record<string, unknown>;
    seq: number;
    messageId: string;
    excludeUserId?: string;
  },
): void {
  const config = core.inboxChannels.get(channelKeyFor(opts.channelName, opts.channelFamily));
  if (!config) return;

  const { sql } = core.storage;
  const userIds = listIdentitiesByChannel(sql, opts.channelName, opts.channelFamily).filter(
    (userId) => userId !== '' && userId !== opts.excludeUserId,
  );
  if (userIds.length === 0) return;

  const frame: InboxFrame = {
    seq: opts.seq,
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
  }
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
        seq: row.seq,
        messageId: row.messageId,
        channel: row.channelName,
      },
    });
  }
}

/** Apply a member's `__received__` ack: drop or mark-delivered up to `receivedThrough`. */
export function applyInboxAck(
  sql: Pick<SQLProvider, 'exec'>,
  opts: {
    userId: string;
    channelName: string;
    channelFamily: string | null;
    receivedThrough: number;
    onDelivered: ResolvedInboxOptions['onDelivered'];
  },
): void {
  ackInboxRows(sql, {
    userId: opts.userId,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    receivedThrough: opts.receivedThrough,
    onDelivered: opts.onDelivered,
    now: Date.now(),
  });
  clearInboxWatermarkThrough(sql, {
    userId: opts.userId,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    receivedThrough: opts.receivedThrough,
  });
}

/** Drop a member's rows for a channel it has left. */
export function clearInboxForChannel(
  core: EngineCore,
  key: { userId: string; channelName: string; channelFamily: string | null },
): void {
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
}

/**
 * Back a user's inbox from a set of full frames. Each frame keeps its own
 * seq/messageId so ordering and dedup stay consistent with live traffic; the
 * rows drain on the member's next reconnect, or arrive live if it is connected.
 *
 * Runs the inserted rows through the same retention and overflow-watermark
 * path `fanOutToInbox` uses, so a backfill that pushes a member over its
 * channel's retention cap prunes the same way a live message would, and a
 * member who falls behind because of it still gets a gap on its next drain.
 */
export function backfillInbox(
  sql: Pick<SQLProvider, 'exec' | 'transaction' | 'limits'>,
  opts: {
    channelName: string;
    channelFamily: string | null;
    userId: string;
    frames: readonly InboxFrame[];
    retention?: InboxRetention;
  },
): void {
  if (!opts.userId) return;
  if (opts.frames.length === 0) return;
  insertInboxRowsForUserId(sql, {
    userId: opts.userId,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    frames: opts.frames,
    now: Date.now(),
  });

  if (!opts.retention) return;
  applyInboxRetention(sql, {
    userId: opts.userId,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    retention: opts.retention,
  });
}

/**
 * Prune a member's channel rows past its retention limits and, if anything was
 * evicted, raise its overflow watermark so a later drain turns the eviction
 * into a gap. Shared by the live fan-out path and `backfillInbox` so both
 * enforce retention the same way. Returns the highest evicted seq, or `null`
 * when nothing was pruned.
 */
function applyInboxRetention(
  sql: Pick<SQLProvider, 'exec'>,
  opts: {
    userId: string;
    channelName: string;
    channelFamily: string | null;
    retention: InboxRetention;
  },
): number | null {
  const evictedThrough = pruneInboxRetention(sql, {
    userId: opts.userId,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    retention: opts.retention,
    now: Date.now(),
  });
  if (evictedThrough === null) return null;

  bumpInboxWatermark(sql, {
    userId: opts.userId,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    evictedThroughSeq: evictedThrough,
  });
  return evictedThrough;
}
