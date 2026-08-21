import { chunkForBind } from '~/_engine/sql-batch.ts';
import { familyFromDb, familyToDb } from '~/inbox/db-keys.ts';
import type { SQLProvider } from '~/context.ts';

const CREATE_INBOX_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_inbox (
    user_id        TEXT NOT NULL,
    channel_name   TEXT NOT NULL,
    channel_family TEXT NOT NULL DEFAULT '',
    seq            INTEGER NOT NULL,
    message_id     TEXT NOT NULL,
    event          TEXT NOT NULL,
    payload        TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    delivered_at   INTEGER,
    metadata       TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, channel_name, channel_family, seq)
  )
`;

const CREATE_INBOX_MEMBER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_inbox_member
  ON __wskit_inbox (user_id, seq)
`;

const CREATE_INBOX_WATERMARK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_inbox_watermark (
    user_id             TEXT NOT NULL,
    channel_name        TEXT NOT NULL,
    channel_family      TEXT NOT NULL DEFAULT '',
    evicted_through_seq INTEGER NOT NULL,
    metadata            TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, channel_name, channel_family)
  )
`;

// @__PURE__ lets the bundler drop this when unused; see channel/storage.ts.
const INBOX_SCHEMA_SQL = /* @__PURE__ */ [
  CREATE_INBOX_TABLE_SQL,
  CREATE_INBOX_MEMBER_INDEX_SQL,
  CREATE_INBOX_WATERMARK_TABLE_SQL,
].join(';\n');

/**
 * Create the per-member inbox tables and index. Idempotent — safe to run on
 * every engine boot.
 */
export function ensureInboxSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(INBOX_SCHEMA_SQL);
}

/** How a channel treats a member's rows once they ack them. */
export type OnDelivered = 'delete' | 'retain';

/**
 * Retention limits for a member's inbox rows. `maxAgeMs` is enforced on writes
 * and by the shared durable alarm, so it also cleans quiet channels.
 */
export interface InboxRetention {
  readonly maxAgeMs?: number;
  readonly maxMessages?: number;
}

/** A concrete stored channel scope whose rows need an inbox retention pass. */
export interface InboxRetentionTarget {
  userId: string;
  channelName: string;
  channelFamily: string | null;
}

/**
 * The full outgoing frame captured at fan-out time. `seq` and `messageId` are
 * the inbox message's own identity, shared by every member's copy so each
 * member's cumulative ack lines up and dedup filters a re-delivered frame.
 */
export interface InboxFrame {
  seq: number;
  messageId: string;
  event: string;
  payload: Record<string, unknown>;
}

/**
 * A full frame the developer hands `ctx.channel.inbox().backfill(...)`, one
 * per message being seeded. Shaped like a message on the wire — `seq` and
 * `messageId` nest under `__wskit` — but derived from {@link InboxFrame} so
 * the payload type can never drift from what storage actually accepts.
 */
export interface BackfillMessage extends Pick<InboxFrame, 'event' | 'payload'> {
  __wskit: Pick<InboxFrame, 'seq' | 'messageId'>;
}

/** One stored inbox row, read back for drain or re-delivery. */
export interface InboxRow {
  seq: number;
  messageId: string;
  event: string;
  payload: string;
  channelName: string;
  channelFamily: string | null;
}

/** Bound parameters one inbox row contributes to a batched `INSERT`. */
const INBOX_ROW_PARAMS = 8;

/**
 * Insert one inbox row per member, batched to stay under the adapter's bound-
 * parameter cap and wrapped in a transaction so a multi-batch insert is still
 * all-or-nothing — a message half-delivered to a channel's members is worse
 * than one that failed outright. The frame's `seq`/`messageId` are shared
 * across every row so a member's cumulative ack and the client's dedup both
 * key off one stable identity.
 *
 * An existing row for a `(user_id, channel_name, channel_family, seq)` is left
 * untouched rather than overwritten, so a re-run insert can never clobber a row
 * the member already acknowledged (see {@link ackInboxRows}) back to unread.
 */
export function insertInboxRows(
  sql: Pick<SQLProvider, 'exec' | 'transaction' | 'limits'>,
  params: {
    userIds: readonly string[];
    channelName: string;
    channelFamily: string | null;
    frame: InboxFrame;
    now: number;
  },
): void {
  const { userIds, channelName, channelFamily, frame, now } = params;
  if (userIds.length === 0) return;

  const family = familyToDb(channelFamily);
  const payloadJson = JSON.stringify(frame.payload);
  const rows = userIds.map((userId) => [
    userId,
    channelName,
    family,
    frame.seq,
    frame.messageId,
    frame.event,
    payloadJson,
    now,
  ]);

  const batches = chunkForBind(rows, INBOX_ROW_PARAMS, sql.limits);
  sql.transaction((tx) => {
    for (const batch of batches) {
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, NULL)').join(', ');
      tx.exec(
        `
          INSERT OR IGNORE INTO __wskit_inbox
            (user_id, channel_name, channel_family, seq, message_id, event, payload, created_at, delivered_at)
          VALUES ${placeholders}
        `,
        ...batch.flat(),
      );
    }
  });
}

/**
 * Insert inbox rows for one user from a set of full frames. Backs
 * `ctx.channel.inbox.backfill(...)`. Each frame keeps its own seq/messageId so
 * ordering and dedup stay consistent with live traffic. Batched under the
 * adapter's bound-parameter cap and wrapped in a transaction, same as
 * {@link insertInboxRows}.
 *
 * An existing row is left untouched rather than overwritten, so re-running a
 * backfill (an import script run twice, for example) can never turn an
 * already-acknowledged message back into an unread one.
 */
export function insertInboxRowsForUserId(
  sql: Pick<SQLProvider, 'exec' | 'transaction' | 'limits'>,
  params: {
    userId: string;
    channelName: string;
    channelFamily: string | null;
    frames: readonly InboxFrame[];
    now: number;
  },
): void {
  const { userId, channelName, channelFamily, frames, now } = params;
  if (frames.length === 0) return;

  const family = familyToDb(channelFamily);
  const rows = frames.map((frame) => [
    userId,
    channelName,
    family,
    frame.seq,
    frame.messageId,
    frame.event,
    JSON.stringify(frame.payload),
    now,
  ]);

  const batches = chunkForBind(rows, INBOX_ROW_PARAMS, sql.limits);
  sql.transaction((tx) => {
    for (const batch of batches) {
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, NULL)').join(', ');
      tx.exec(
        `
          INSERT OR IGNORE INTO __wskit_inbox
            (user_id, channel_name, channel_family, seq, message_id, event, payload, created_at, delivered_at)
          VALUES ${placeholders}
        `,
        ...batch.flat(),
      );
    }
  });
}

/**
 * Read a member's undelivered rows across every channel, ordered by channel and
 * seq. In `delete` mode nothing is ever marked delivered, so every remaining row
 * is still owed; in `retain` mode a row stays owed until its `delivered_at` is set.
 */
export function loadUndeliveredRows(sql: Pick<SQLProvider, 'exec'>, userId: string): InboxRow[] {
  const rows = sql
    .exec<{
      seq: number;
      message_id: string;
      event: string;
      payload: string;
      channel_name: string;
      channel_family: string;
    }>(
      `
        SELECT seq, message_id, event, payload, channel_name, channel_family
        FROM __wskit_inbox
        WHERE user_id = ? AND delivered_at IS NULL
        ORDER BY channel_name, channel_family, seq ASC
      `,
      userId,
    )
    .toArray();

  return rows.map((row) => ({
    seq: Number(row.seq),
    messageId: String(row.message_id),
    event: String(row.event),
    payload: String(row.payload),
    channelName: String(row.channel_name),
    channelFamily: familyFromDb(String(row.channel_family)),
  }));
}

/**
 * Apply one member's cumulative ack. In `delete` mode the acked rows are dropped
 * outright; in `retain` mode they are stamped `delivered_at` so retention can age
 * them out later. Both are idempotent — a repeated or lower `receivedThrough`
 * changes nothing already settled.
 */
export function ackInboxRows(
  sql: Pick<SQLProvider, 'exec'>,
  params: {
    userId: string;
    channelName: string;
    channelFamily: string | null;
    receivedThrough: number;
    onDelivered: OnDelivered;
    now: number;
  },
): void {
  const { userId, channelName, channelFamily, receivedThrough, onDelivered, now } = params;
  const family = familyToDb(channelFamily);

  if (onDelivered === 'delete') {
    sql.exec(
      `
        DELETE FROM __wskit_inbox
        WHERE user_id = ? AND channel_name = ? AND channel_family = ? AND seq <= ?
      `,
      userId,
      channelName,
      family,
      receivedThrough,
    );
    return;
  }

  sql.exec(
    `
      UPDATE __wskit_inbox
      SET delivered_at = ?
      WHERE user_id = ? AND channel_name = ? AND channel_family = ?
        AND seq <= ? AND delivered_at IS NULL
    `,
    now,
    userId,
    channelName,
    family,
    receivedThrough,
  );
}

/** Drop every inbox row a member has for one channel. Used when they leave it. */
export function deleteInboxRowsForChannel(
  sql: Pick<SQLProvider, 'exec'>,
  params: { userId: string; channelName: string; channelFamily: string | null },
): void {
  sql.exec(
    `
      DELETE FROM __wskit_inbox
      WHERE user_id = ? AND channel_name = ? AND channel_family = ?
    `,
    params.userId,
    params.channelName,
    familyToDb(params.channelFamily),
  );
}

/** Count a member's inbox rows for one channel. */
export function countInboxRows(
  sql: Pick<SQLProvider, 'exec'>,
  params: { userId: string; channelName: string; channelFamily: string | null },
): number {
  const row = sql
    .exec<{
      n: number;
    }>(
      `SELECT COUNT(*) AS n FROM __wskit_inbox WHERE user_id = ? AND channel_name = ? AND channel_family = ?`,
      params.userId,
      params.channelName,
      familyToDb(params.channelFamily),
    )
    .one();
  return row ? Number(row.n) : 0;
}

/**
 * Return the first timestamp at which a row in a configured channel can be
 * pruned by its age bound. The `+ 1` matches the strict `created_at < cutoff`
 * predicate used by pruning and avoids re-arming an alarm for the same exact
 * millisecond when a row is exactly at its age limit.
 */
export function nextInboxRetentionAt(
  sql: Pick<SQLProvider, 'exec'>,
  params: { channelKey: string; maxAgeMs: number },
): number | null {
  const row = sql
    .exec<{ next_at: number | null }>(
      `
        SELECT MIN(created_at + ? + 1) AS next_at
        FROM __wskit_inbox
        WHERE (channel_name = ? AND channel_family = '') OR channel_family = ?
      `,
      params.maxAgeMs,
      params.channelKey,
      params.channelKey,
    )
    .one();
  return row?.next_at == null ? null : Number(row.next_at);
}

/** List concrete member/channel scopes with at least one expired inbox row. */
export function listExpiredInboxRetentionTargets(
  sql: Pick<SQLProvider, 'exec'>,
  params: { channelKey: string; maxAgeMs: number; now: number },
): InboxRetentionTarget[] {
  const cutoff = params.now - params.maxAgeMs;
  return sql
    .exec<{ user_id: string; channel_name: string; channel_family: string }>(
      `
        SELECT DISTINCT user_id, channel_name, channel_family
        FROM __wskit_inbox
        WHERE ((channel_name = ? AND channel_family = '') OR channel_family = ?)
          AND created_at < ?
      `,
      params.channelKey,
      params.channelKey,
      cutoff,
    )
    .toArray()
    .map((row) => ({
      userId: String(row.user_id),
      channelName: String(row.channel_name),
      channelFamily: familyFromDb(String(row.channel_family)),
    }));
}

/** List every concrete member/channel scope under one configured channel key. */
export function listInboxRetentionTargets(
  sql: Pick<SQLProvider, 'exec'>,
  params: { channelKey: string },
): InboxRetentionTarget[] {
  return sql
    .exec<{ user_id: string; channel_name: string; channel_family: string }>(
      `
        SELECT DISTINCT user_id, channel_name, channel_family
        FROM __wskit_inbox
        WHERE (channel_name = ? AND channel_family = '') OR channel_family = ?
      `,
      params.channelKey,
      params.channelKey,
    )
    .toArray()
    .map((row) => ({
      userId: String(row.user_id),
      channelName: String(row.channel_name),
      channelFamily: familyFromDb(String(row.channel_family)),
    }));
}

/**
 * Enforce a member's retention limits for one channel by dropping the oldest
 * rows past the age or count cap — including undelivered rows, since a member
 * that falls too far behind is exactly the overflow case. Returns the highest
 * seq that was evicted, or `null` when nothing was dropped. The transactional
 * wrapper separately tracks whether an undelivered row was removed before
 * raising the member's overflow watermark.
 */
export function pruneInboxRetention(
  sql: Pick<SQLProvider, 'exec'>,
  params: {
    userId: string;
    channelName: string;
    channelFamily: string | null;
    retention: InboxRetention;
    now: number;
  },
): number | null {
  return pruneInboxRetentionDetailed(sql, params).evictedThrough;
}

interface InboxRetentionEviction {
  evictedThrough: number | null;
  undeliveredEvictedThrough: number | null;
}

function pruneInboxRetentionDetailed(
  sql: Pick<SQLProvider, 'exec'>,
  params: {
    userId: string;
    channelName: string;
    channelFamily: string | null;
    retention: InboxRetention;
    now: number;
  },
): InboxRetentionEviction {
  const { userId, channelName, channelFamily, retention, now } = params;
  const family = familyToDb(channelFamily);
  let eviction: InboxRetentionEviction = {
    evictedThrough: null,
    undeliveredEvictedThrough: null,
  };

  if (retention.maxAgeMs !== undefined) {
    const cutoff = now - retention.maxAgeMs;
    eviction = mergeRetentionEvictions(
      eviction,
      evictOldest(sql, {
        userId,
        channelName,
        family,
        where: 'created_at < ?',
        bind: [cutoff],
      }),
    );
  }

  if (retention.maxMessages !== undefined) {
    const seqCap = sql
      .exec<{ seq: number | null }>(
        `
          SELECT MAX(seq) AS seq FROM (
            SELECT seq FROM __wskit_inbox
            WHERE user_id = ? AND channel_name = ? AND channel_family = ?
            ORDER BY seq DESC
            LIMIT -1 OFFSET ?
          )
        `,
        userId,
        channelName,
        family,
        retention.maxMessages,
      )
      .one();
    if (seqCap?.seq != null) {
      eviction = mergeRetentionEvictions(
        eviction,
        evictOldest(sql, {
          userId,
          channelName,
          family,
          where: 'seq <= ?',
          bind: [Number(seqCap.seq)],
        }),
      );
    }
  }

  return eviction;
}

/**
 * Prune a member's channel rows and persist the resulting overflow watermark
 * as one atomic operation. If either the deletes or the watermark write fails,
 * SQLite rolls the whole retention pass back so an undelivered row can never be
 * lost without the gap that describes it. Delivered rows are already
 * acknowledged and therefore do not create a new gap.
 */
export function pruneInboxRetentionAndBumpWatermark(
  sql: Pick<SQLProvider, 'exec' | 'transaction'>,
  params: {
    userId: string;
    channelName: string;
    channelFamily: string | null;
    retention: InboxRetention;
    now: number;
  },
): number | null {
  return sql.transaction((tx) => {
    const eviction = pruneInboxRetentionDetailed(tx, params);
    if (eviction.evictedThrough === null) return null;

    if (eviction.undeliveredEvictedThrough !== null) {
      bumpInboxWatermark(tx, {
        userId: params.userId,
        channelName: params.channelName,
        channelFamily: params.channelFamily,
        evictedThroughSeq: eviction.undeliveredEvictedThrough,
      });
    }
    return eviction.evictedThrough;
  });
}

/** Delete the member's rows matching `where` and report delivered state. */
function evictOldest(
  sql: Pick<SQLProvider, 'exec'>,
  params: {
    userId: string;
    channelName: string;
    family: string;
    where: string;
    bind: unknown[];
  },
): InboxRetentionEviction {
  const { userId, channelName, family, where, bind } = params;
  const scope = [userId, channelName, family];
  const highest = sql
    .exec<{ seq: number | null; undelivered_seq: number | null }>(
      `
        SELECT
          MAX(seq) AS seq,
          MAX(CASE WHEN delivered_at IS NULL THEN seq END) AS undelivered_seq
        FROM __wskit_inbox
        WHERE user_id = ? AND channel_name = ? AND channel_family = ? AND ${where}
      `,
      ...scope,
      ...bind,
    )
    .one();
  if (highest?.seq == null) {
    return { evictedThrough: null, undeliveredEvictedThrough: null };
  }

  sql.exec(
    `
      DELETE FROM __wskit_inbox
      WHERE user_id = ? AND channel_name = ? AND channel_family = ? AND ${where}
    `,
    ...scope,
    ...bind,
  );
  return {
    evictedThrough: Number(highest.seq),
    undeliveredEvictedThrough:
      highest.undelivered_seq == null ? null : Number(highest.undelivered_seq),
  };
}

function mergeRetentionEvictions(
  first: InboxRetentionEviction,
  second: InboxRetentionEviction,
): InboxRetentionEviction {
  return {
    evictedThrough: maxNullable(first.evictedThrough, second.evictedThrough),
    undeliveredEvictedThrough: maxNullable(
      first.undeliveredEvictedThrough,
      second.undeliveredEvictedThrough,
    ),
  };
}

function maxNullable(first: number | null, second: number | null): number | null {
  if (first === null) return second;
  if (second === null) return first;
  return Math.max(first, second);
}

/**
 * Raise a member's overflow watermark to the highest undelivered seq retention
 * evicted, so a later drain knows the member missed everything up to that point.
 * Never lowers an existing watermark.
 */
export function bumpInboxWatermark(
  sql: Pick<SQLProvider, 'exec'>,
  params: {
    userId: string;
    channelName: string;
    channelFamily: string | null;
    evictedThroughSeq: number;
  },
): void {
  const { userId, channelName, channelFamily, evictedThroughSeq } = params;
  const family = familyToDb(channelFamily);
  const existing = sql
    .exec<{ evicted_through_seq: number }>(
      `
        SELECT evicted_through_seq FROM __wskit_inbox_watermark
        WHERE user_id = ? AND channel_name = ? AND channel_family = ?
      `,
      userId,
      channelName,
      family,
    )
    .one();

  if (existing && Number(existing.evicted_through_seq) >= evictedThroughSeq) return;

  sql.exec(
    `
      INSERT OR REPLACE INTO __wskit_inbox_watermark
        (user_id, channel_name, channel_family, evicted_through_seq)
      VALUES (?, ?, ?, ?)
    `,
    userId,
    channelName,
    family,
    evictedThroughSeq,
  );
}

/** Every scope where a member's inbox overflowed, to turn into a gap on the next drain. */
export function loadInboxWatermarks(
  sql: Pick<SQLProvider, 'exec'>,
  userId: string,
): Array<{ channelName: string; channelFamily: string | null; evictedThroughSeq: number }> {
  return sql
    .exec<{ channel_name: string; channel_family: string; evicted_through_seq: number }>(
      `
        SELECT channel_name, channel_family, evicted_through_seq
        FROM __wskit_inbox_watermark
        WHERE user_id = ?
      `,
      userId,
    )
    .toArray()
    .map((row) => ({
      channelName: String(row.channel_name),
      channelFamily: familyFromDb(String(row.channel_family)),
      evictedThroughSeq: Number(row.evicted_through_seq),
    }));
}

/** Drop a member's overflow watermarks. Used by a full user purge. */
export function clearInboxWatermarks(sql: Pick<SQLProvider, 'exec'>, userId: string): void {
  sql.exec(`DELETE FROM __wskit_inbox_watermark WHERE user_id = ?`, userId);
}

/** Drop a member's channel watermark once an acknowledgement covers its gap. */
export function clearInboxWatermarkThrough(
  sql: Pick<SQLProvider, 'exec'>,
  params: {
    userId: string;
    channelName: string;
    channelFamily: string | null;
    receivedThrough: number;
  },
): void {
  sql.exec(
    `
      DELETE FROM __wskit_inbox_watermark
      WHERE user_id = ? AND channel_name = ? AND channel_family = ?
        AND evicted_through_seq <= ?
    `,
    params.userId,
    params.channelName,
    familyToDb(params.channelFamily),
    params.receivedThrough,
  );
}

/**
 * Remove inbox data for channel scopes no longer present in the deployed
 * contract. Inbox rows are intentionally scoped by both the concrete channel
 * name and family key, so a removed static channel cannot retain data merely
 * because a dynamic family happens to use the same string in a later deploy.
 */
export function deleteInboxRowsOutsideScopes(
  sql: Pick<SQLProvider, 'exec' | 'transaction'>,
  scopes: { staticNames: readonly string[]; familyKeys: readonly string[] },
): void {
  const staticNames = new Set(scopes.staticNames);
  const familyKeys = new Set(scopes.familyKeys);

  sql.transaction((tx) => {
    // Do not put every active scope into one IN (...) list: a large contract
    // can exceed the adapter's bound-parameter limit. Stored scope pairs are
    // already the smallest set we need to inspect, and stale pairs are
    // removed one at a time inside the same transaction.
    const storedScopes = tx
      .exec<{ channel_name: string; channel_family: string }>(
        `
        SELECT channel_name, channel_family FROM __wskit_inbox
        UNION
        SELECT channel_name, channel_family FROM __wskit_inbox_watermark
        UNION
        SELECT channel_name, channel_family FROM __wskit_inbox_receipts
      `,
      )
      .toArray();

    for (const scope of storedScopes) {
      const active =
        scope.channel_family === ''
          ? staticNames.has(scope.channel_name)
          : familyKeys.has(scope.channel_family);
      if (active) continue;

      tx.exec(
        `DELETE FROM __wskit_inbox WHERE channel_name = ? AND channel_family = ?`,
        scope.channel_name,
        scope.channel_family,
      );
      tx.exec(
        `DELETE FROM __wskit_inbox_watermark WHERE channel_name = ? AND channel_family = ?`,
        scope.channel_name,
        scope.channel_family,
      );
      tx.exec(
        `DELETE FROM __wskit_inbox_receipts WHERE channel_name = ? AND channel_family = ?`,
        scope.channel_name,
        scope.channel_family,
      );
    }
  });
}

/**
 * Drop a member's overflow watermark for one channel. Used when they leave it, so
 * a later reconnect does not emit a gap for a channel they are no longer in.
 */
export function deleteInboxWatermarkForChannel(
  sql: Pick<SQLProvider, 'exec'>,
  params: { userId: string; channelName: string; channelFamily: string | null },
): void {
  sql.exec(
    `
      DELETE FROM __wskit_inbox_watermark
      WHERE user_id = ? AND channel_name = ? AND channel_family = ?
    `,
    params.userId,
    params.channelName,
    familyToDb(params.channelFamily),
  );
}
