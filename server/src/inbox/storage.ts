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

const INBOX_SCHEMA_SQL = [
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

/** Retention limits for a member's kept (delivered) inbox rows. */
export interface InboxRetention {
  readonly maxAgeMs?: number;
  readonly maxMessages?: number;
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

/** One stored inbox row, read back for drain or re-delivery. */
export interface InboxRow {
  seq: number;
  messageId: string;
  event: string;
  payload: string;
  channelName: string;
  channelFamily: string | null;
}

/**
 * Insert one inbox row per member in a single batched statement. The frame's
 * `seq`/`messageId` are shared across every row so a member's cumulative ack
 * and the client's dedup both key off one stable identity.
 */
export function insertInboxRows(
  sql: Pick<SQLProvider, 'exec'>,
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
  const rowValues: unknown[] = [];
  const placeholders: string[] = [];
  for (const userId of userIds) {
    placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, NULL)');
    rowValues.push(
      userId,
      channelName,
      family,
      frame.seq,
      frame.messageId,
      frame.event,
      payloadJson,
      now,
    );
  }

  sql.exec(
    `
      INSERT OR REPLACE INTO __wskit_inbox
        (user_id, channel_name, channel_family, seq, message_id, event, payload, created_at, delivered_at)
      VALUES ${placeholders.join(', ')}
    `,
    ...rowValues,
  );
}

/**
 * Insert inbox rows for one user from a set of full frames. Backs
 * `ctx.channel.inbox.backfill(...)`. Each frame keeps its own seq/messageId so
 * ordering and dedup stay consistent with live traffic.
 */
export function insertInboxRowsForUserId(
  sql: Pick<SQLProvider, 'exec'>,
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
  const rowValues: unknown[] = [];
  const placeholders: string[] = [];
  for (const frame of frames) {
    placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, NULL)');
    rowValues.push(
      userId,
      channelName,
      family,
      frame.seq,
      frame.messageId,
      frame.event,
      JSON.stringify(frame.payload),
      now,
    );
  }

  sql.exec(
    `
      INSERT OR REPLACE INTO __wskit_inbox
        (user_id, channel_name, channel_family, seq, message_id, event, payload, created_at, delivered_at)
      VALUES ${placeholders.join(', ')}
    `,
    ...rowValues,
  );
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
 * Enforce a member's retention limits for one channel by dropping the oldest
 * rows past the age or count cap — including undelivered rows, since a member
 * that falls too far behind is exactly the overflow case. Returns the highest
 * seq that was evicted, or `null` when nothing was dropped, so the caller can
 * raise the member's overflow watermark (which a later drain turns into a gap).
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
  const { userId, channelName, channelFamily, retention, now } = params;
  const family = familyToDb(channelFamily);
  let evictedThrough: number | null = null;

  if (retention.maxAgeMs !== undefined) {
    const cutoff = now - retention.maxAgeMs;
    evictedThrough = evictOldest(sql, {
      userId,
      channelName,
      family,
      where: 'created_at < ?',
      bind: [cutoff],
      previous: evictedThrough,
    });
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
      evictedThrough = evictOldest(sql, {
        userId,
        channelName,
        family,
        where: 'seq <= ?',
        bind: [Number(seqCap.seq)],
        previous: evictedThrough,
      });
    }
  }

  return evictedThrough;
}

/** Delete the member's rows matching `where` and return the highest seq removed. */
function evictOldest(
  sql: Pick<SQLProvider, 'exec'>,
  params: {
    userId: string;
    channelName: string;
    family: string;
    where: string;
    bind: unknown[];
    previous: number | null;
  },
): number | null {
  const { userId, channelName, family, where, bind, previous } = params;
  const scope = [userId, channelName, family];
  const highest = sql
    .exec<{ seq: number | null }>(
      `
        SELECT MAX(seq) AS seq FROM __wskit_inbox
        WHERE user_id = ? AND channel_name = ? AND channel_family = ? AND ${where}
      `,
      ...scope,
      ...bind,
    )
    .one();
  if (highest?.seq == null) return previous;

  sql.exec(
    `
      DELETE FROM __wskit_inbox
      WHERE user_id = ? AND channel_name = ? AND channel_family = ? AND ${where}
    `,
    ...scope,
    ...bind,
  );
  return Math.max(previous ?? 0, Number(highest.seq));
}

/**
 * Raise a member's overflow watermark to the highest seq retention evicted, so a
 * later drain knows the member missed everything up to that point. Never lowers
 * an existing watermark.
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

/** Drop a member's overflow watermarks once their gap has been delivered on drain. */
export function clearInboxWatermarks(sql: Pick<SQLProvider, 'exec'>, userId: string): void {
  sql.exec(`DELETE FROM __wskit_inbox_watermark WHERE user_id = ?`, userId);
}

/**
 * Delete every inbox row and overflow watermark for one user, across every
 * channel. Used by `purgeUser`.
 */
export function purgeInboxByUser(sql: Pick<SQLProvider, 'exec'>, userId: string): void {
  sql.exec('DELETE FROM __wskit_inbox WHERE user_id = ?', userId);
  clearInboxWatermarks(sql, userId);
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
