import { storedRowBytes, toBytes } from '~/_engine/runtime/stored-row.ts';
import { chunkForBind } from '~/_engine/sql-batch.ts';
import { familyFromDb, familyToDb } from '~/inbox/db-keys.ts';
import type { SQLProvider } from '~/context.ts';

type PruneInboxRetentionAndBumpWatermarkParamsParameter = {
  userId: string;
  channelName: string;
  channelFamily: string | null;
  retention: InboxRetention;
  now: number;
};

const CREATE_INBOX_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_inbox (
    user_id        TEXT NOT NULL,
    channel_name   TEXT NOT NULL,
    channel_family TEXT NOT NULL DEFAULT '',
    seq            INTEGER NOT NULL,
    message_id     TEXT NOT NULL,
    event          TEXT NOT NULL,
    -- The JSON payload, or the info of a binary event.
    payload        TEXT NOT NULL,
    -- The bytes of a binary event, or NULL for a JSON event.
    binary_payload BLOB,
    -- The UTF-8 bytes of payload plus the bytes of binary_payload: what retention.maxBytes counts.
    row_bytes      INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    metadata       TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, channel_name, channel_family, seq)
  )
`;

const CREATE_INBOX_MEMBER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __livething_idx_inbox_member
  ON __livething_inbox (user_id, seq)
`;

// One stored copy of a message per member per channel: every insert is
// INSERT OR IGNORE, so a message id already held for that member is skipped.
const CREATE_INBOX_MESSAGE_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS __livething_idx_inbox_message
  ON __livething_inbox (user_id, channel_name, channel_family, message_id)
`;

const CREATE_INBOX_WATERMARK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_inbox_watermark (
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
  CREATE_INBOX_MESSAGE_INDEX_SQL,
  CREATE_INBOX_WATERMARK_TABLE_SQL,
].join(';\n');

/**
 * Create the per-member inbox tables and index. Idempotent — safe to run on
 * every engine boot.
 */
export function ensureInboxSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(INBOX_SCHEMA_SQL);
}

/**
 * Retention limits for a member's inbox rows. `maxAgeMs` is enforced on writes
 * and by the shared durable alarm, so it also cleans quiet channels.
 */
export interface InboxRetention {
  readonly maxAgeMs?: number;
  readonly maxMessages?: number;
  /**
   * The most bytes a member's rows of one channel may hold: the UTF-8 bytes of each row's JSON
   * payload (or a binary event's info), plus a binary event's bytes. Over it, the oldest rows
   * are deleted, as for `maxMessages`. A message that alone is over it is not sent at all.
   */
  readonly maxBytes?: number;
}

/** A concrete stored channel scope whose rows need an inbox retention pass. */
export interface InboxRetentionTarget {
  userId: string;
  channelName: string;
  channelFamily: string | null;
}

/**
 * The full outgoing frame captured at fan-out time. Storage `seq` becomes
 * wire `deliverySeq`, alongside `messageId`; both are
 * the inbox message's own identity, shared by every member's copy so each
 * member's cumulative ack lines up and dedup filters a re-delivered frame.
 */
export interface InboxFrame {
  deliverySeq: number;
  messageId: string;
  event: string;
  payload: Record<string, unknown> | null;
  /** The bytes of a binary event. */
  bytes?: Uint8Array;
}

/**
 * A message the developer hands `ctx.channel.inbox().backfill(...)`, one per
 * message being seeded. `messageId` nests under `__livething` as on the wire;
 * the server picks the `deliverySeq`. Derived from {@link InboxFrame} so the
 * payload type can never drift from what storage actually accepts.
 */
export interface BackfillMessage extends Pick<InboxFrame, 'event' | 'payload'> {
  __livething: Pick<InboxFrame, 'messageId'>;
}

/** One stored inbox row, read back for drain or re-delivery. */
export interface InboxRow {
  seq: number;
  messageId: string;
  event: string;
  payload: string;
  /** The bytes of a binary event, or `null` for a JSON event. */
  binaryPayload: Uint8Array | null;
  channelName: string;
  channelFamily: string | null;
}

interface InboxInsertParams {
  userIds: readonly string[];
  channelName: string;
  channelFamily: string | null;
  frame: InboxFrame;
  now: number;
}

interface InboxBackfillParams {
  userId: string;
  channelName: string;
  channelFamily: string | null;
  frames: readonly InboxFrame[];
  now: number;
}

interface InboxAckParams {
  userId: string;
  channelName: string;
  channelFamily: string | null;
  receivedThrough: number;
}

interface InboxChannelScope {
  userId: string;
  channelName: string;
  channelFamily: string | null;
}

interface InboxRetentionLookupParams {
  channelKey: string;
  maxAgeMs: number;
}

interface InboxExpiredRetentionParams extends InboxRetentionLookupParams {
  now: number;
}

interface InboxPruneParams extends InboxChannelScope {
  retention: InboxRetention;
  now: number;
}

interface InboxEvictionParams {
  userId: string;
  channelName: string;
  family: string;
  where: string;
  bind: unknown[];
}

interface InboxWatermarkParams extends InboxChannelScope {
  evictedThroughSeq: number;
}

interface InboxScopeSet {
  staticNames: readonly string[];
  familyKeys: readonly string[];
}

/** Bound parameters one inbox row contributes to a batched `INSERT`. */
const INBOX_ROW_PARAMS = 10;

/**
 * The bound values of the message in one inbox row, in the column order `writeInboxRows`
 * uses after the member and the channel. One broadcast's rows share them.
 */
function inboxMessageValues(frame: InboxFrame, now: number): unknown[] {
  const payloadJson = JSON.stringify(frame.payload);
  return [
    frame.deliverySeq,
    frame.messageId,
    frame.event,
    payloadJson,
    frame.bytes ?? null,
    storedRowBytes(payloadJson, frame.bytes),
    now,
  ];
}

/**
 * Write rows of the member, the channel and `inboxMessageValues`, in batches under the
 * bound-parameter cap, in one transaction.
 */
function writeInboxRows(
  sql: Pick<SQLProvider, 'exec' | 'transaction' | 'limits'>,
  rows: unknown[][],
): void {
  const batches = chunkForBind(rows, INBOX_ROW_PARAMS, sql.limits);
  sql.transaction(() => {
    for (const batch of batches) {
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      sql.exec(
        `
          INSERT OR IGNORE INTO __livething_inbox
            (user_id, channel_name, channel_family, seq, message_id, event, payload,
              binary_payload, row_bytes, created_at)
          VALUES ${placeholders}
        `,
        ...batch.flat(),
      );
    }
  });
}

/**
 * Insert one inbox row per member, batched to stay under the adapter's bound-
 * parameter cap and wrapped in a transaction so a multi-batch insert is still
 * all-or-nothing — a message half-delivered to a channel's members is worse
 * than one that failed outright. The frame's `deliverySeq`/`messageId` are shared
 * across every row so a member's cumulative ack and the client's dedup both
 * key off one stable identity.
 *
 * A member that already holds a row with this seq or this message id keeps
 * that row; the new one is skipped.
 */
export function insertInboxRows(
  sql: Pick<SQLProvider, 'exec' | 'transaction' | 'limits'>,
  params: InboxInsertParams,
): void {
  const { userIds, channelName, channelFamily, frame, now } = params;
  if (userIds.length === 0) return;

  const family = familyToDb(channelFamily);
  const message = inboxMessageValues(frame, now);
  writeInboxRows(
    sql,
    userIds.map((userId) => [userId, channelName, family, ...message]),
  );
}

/**
 * Insert inbox rows for one user from a set of full frames. Backs
 * `ctx.channel.inbox.backfill(...)`, whose frames carry seqs taken from the
 * server's sequence counter. Batched under the adapter's bound-parameter cap and
 * wrapped in a transaction, same as {@link insertInboxRows}.
 *
 * A message id the member already holds on this channel is skipped, so
 * re-running a backfill (an import script run twice, for example) stores nothing new.
 */
export function insertInboxRowsForUserId(
  sql: Pick<SQLProvider, 'exec' | 'transaction' | 'limits'>,
  params: InboxBackfillParams,
): void {
  const { userId, channelName, channelFamily, frames, now } = params;
  if (frames.length === 0) return;

  const family = familyToDb(channelFamily);
  writeInboxRows(
    sql,
    frames.map((frame) => [userId, channelName, family, ...inboxMessageValues(frame, now)]),
  );
}

/** The seqs in `[fromSeq, toSeq]` that a member still holds on one channel. */
export function listStoredInboxSeqs(
  sql: Pick<SQLProvider, 'exec'>,
  params: InboxChannelScope & { fromSeq: number; toSeq: number },
): Set<number> {
  const rows = sql
    .exec<{ seq: number }>(
      `
        SELECT seq FROM __livething_inbox
        WHERE user_id = ? AND channel_name = ? AND channel_family = ? AND seq BETWEEN ? AND ?
      `,
      params.userId,
      params.channelName,
      familyToDb(params.channelFamily),
      params.fromSeq,
      params.toSeq,
    )
    .toArray();

  return new Set(rows.map((row) => Number(row.seq)));
}

/** One page of a member's rows: the rows after `after`, at most `maxRows`, about `maxBytes`. */
export interface InboxPage {
  after?: Pick<InboxRow, 'channelName' | 'channelFamily' | 'seq'>;
  maxRows?: number;
  /** The page stops before the row that would take it over, but always has one row. */
  maxBytes?: number;
}

/**
 * Read a member's undelivered rows across every channel, ordered by channel and
 * seq. An ack deletes rows, so every stored row is still owed. With a `page`, read
 * only that page of them.
 */
export function loadUndeliveredRows(
  sql: Pick<SQLProvider, 'exec'>,
  userId: string,
  page: InboxPage = {},
): InboxRow[] {
  const { after } = page;
  let where = 'user_id = ?';
  const params: unknown[] = [userId];
  // A row-value comparison in the primary key's order: each page is one seek on that index,
  // with no sort. A filter on `seq` alone would make SQLite pick the (user_id, seq) index and
  // sort every page, so a long drain would get slower with each page.
  if (after) {
    where += ' AND (channel_name, channel_family, seq) > (?, ?, ?)';
    params.push(after.channelName, familyToDb(after.channelFamily), after.seq);
  }

  const order = 'ORDER BY channel_name, channel_family, seq ASC';
  let limit = page.maxRows ?? -1;
  if (page.maxBytes !== undefined) {
    // Read the sizes first, so a page of big binary rows is never read whole.
    const sizes = sql
      .exec<{
        row_bytes: number;
      }>(
        `SELECT row_bytes FROM __livething_inbox WHERE ${where} ${order} LIMIT ?`,
        ...params,
        limit,
      )
      .toArray();
    let bytes = 0;
    limit = 0;
    for (const size of sizes) {
      bytes += Number(size.row_bytes);
      if (limit > 0 && bytes > page.maxBytes) break;

      limit += 1;
    }

    if (limit === 0) return [];
  }

  const rows = sql
    .exec<{
      seq: number;
      message_id: string;
      event: string;
      payload: string;
      binary_payload: unknown;
      channel_name: string;
      channel_family: string;
    }>(
      `
        SELECT seq, message_id, event, payload, binary_payload, channel_name, channel_family
        FROM __livething_inbox
        WHERE ${where}
        ${order}
        LIMIT ?
      `,
      ...params,
      limit,
    )
    .toArray();

  return rows.map((row) => ({
    seq: Number(row.seq),
    messageId: String(row.message_id),
    event: String(row.event),
    payload: String(row.payload),
    binaryPayload: toBytes(row.binary_payload),
    channelName: String(row.channel_name),
    channelFamily: familyFromDb(String(row.channel_family)),
  }));
}

/** The channels a member has undelivered rows in, each with the highest seq it holds there. */
export function listInboxChannelsOf(
  sql: Pick<SQLProvider, 'exec'>,
  userId: string,
): Array<{ channelName: string; channelFamily: string | null; maxSeq: number }> {
  return sql
    .exec<{ channel_name: string; channel_family: string; max_seq: number }>(
      `
        SELECT channel_name, channel_family, MAX(seq) AS max_seq FROM __livething_inbox
        WHERE user_id = ? GROUP BY channel_name, channel_family
      `,
      userId,
    )
    .toArray()
    .map((row) => ({
      channelName: String(row.channel_name),
      channelFamily: familyFromDb(String(row.channel_family)),
      maxSeq: Number(row.max_seq),
    }));
}

/**
 * Apply one member's cumulative ack by deleting the acked rows. Idempotent — a
 * repeated or lower `receivedThrough` changes nothing.
 */
export function ackInboxRows(sql: Pick<SQLProvider, 'exec'>, params: InboxAckParams): void {
  sql.exec(
    `
      DELETE FROM __livething_inbox
      WHERE user_id = ? AND channel_name = ? AND channel_family = ? AND seq <= ?
    `,
    params.userId,
    params.channelName,
    familyToDb(params.channelFamily),
    params.receivedThrough,
  );
}

/** Drop every inbox row a member has for one channel. Used when they leave it. */
export function deleteInboxRowsForChannel(
  sql: Pick<SQLProvider, 'exec'>,
  params: InboxChannelScope,
): void {
  sql.exec(
    `
      DELETE FROM __livething_inbox
      WHERE user_id = ? AND channel_name = ? AND channel_family = ?
    `,
    params.userId,
    params.channelName,
    familyToDb(params.channelFamily),
  );
}

/** What a member's inbox rows of one channel hold: how many, and their `row_bytes` together. */
export interface InboxHeld {
  rows: number;
  bytes: number;
}

/** Count a member's inbox rows for one channel, and their bytes. */
export function countInboxRows(
  sql: Pick<SQLProvider, 'exec'>,
  params: InboxChannelScope,
): InboxHeld {
  const row = sql
    .exec<{
      n: number;
      b: number | null;
    }>(
      `SELECT COUNT(*) AS n, SUM(row_bytes) AS b FROM __livething_inbox WHERE user_id = ? AND channel_name = ? AND channel_family = ?`,
      params.userId,
      params.channelName,
      familyToDb(params.channelFamily),
    )
    .one();
  return { rows: row ? Number(row.n) : 0, bytes: row?.b == null ? 0 : Number(row.b) };
}

/**
 * Return the first timestamp at which a row in a configured channel can be
 * pruned by its age bound. The `+ 1` matches the strict `created_at < cutoff`
 * predicate used by pruning and avoids re-arming an alarm for the same exact
 * millisecond when a row is exactly at its age limit.
 */
export function nextInboxRetentionAt(
  sql: Pick<SQLProvider, 'exec'>,
  params: InboxRetentionLookupParams,
): number | null {
  const row = sql
    .exec<{ next_at: number | null }>(
      `
        SELECT MIN(created_at + ? + 1) AS next_at
        FROM __livething_inbox
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
  params: InboxExpiredRetentionParams,
): InboxRetentionTarget[] {
  const cutoff = params.now - params.maxAgeMs;
  return sql
    .exec<{ user_id: string; channel_name: string; channel_family: string }>(
      `
        SELECT DISTINCT user_id, channel_name, channel_family
        FROM __livething_inbox
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
  params: Pick<InboxRetentionLookupParams, 'channelKey'>,
): InboxRetentionTarget[] {
  return sql
    .exec<{ user_id: string; channel_name: string; channel_family: string }>(
      `
        SELECT DISTINCT user_id, channel_name, channel_family
        FROM __livething_inbox
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
 * rows past the age, count or byte cap. Every stored row is undelivered, so a member
 * that falls too far behind is exactly the overflow case. Reports the highest
 * evicted seq.
 */
function pruneInboxRetentionRows(
  sql: Pick<SQLProvider, 'exec'>,
  params: InboxPruneParams,
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
    });
  }

  if (retention.maxMessages !== undefined) {
    const seqCap = sql
      .exec<{ seq: number | null }>(
        `
          SELECT MAX(seq) AS seq FROM (
            SELECT seq FROM __livething_inbox
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
      const evicted = evictOldest(sql, {
        userId,
        channelName,
        family,
        where: 'seq <= ?',
        bind: [Number(seqCap.seq)],
      });
      if (evicted !== null) evictedThrough = Math.max(evictedThrough ?? evicted, evicted);
    }
  }

  if (retention.maxBytes !== undefined) {
    // The newest row at which the bytes of the rows from it to the newest are over the limit.
    // It and every older row go.
    const seqCap = sql
      .exec<{ seq: number | null }>(
        `
          SELECT MAX(seq) AS seq FROM (
            SELECT seq, SUM(row_bytes) OVER (ORDER BY seq DESC ROWS UNBOUNDED PRECEDING) AS kept
            FROM __livething_inbox
            WHERE user_id = ? AND channel_name = ? AND channel_family = ?
          )
          WHERE kept > ?
        `,
        userId,
        channelName,
        family,
        retention.maxBytes,
      )
      .one();
    if (seqCap?.seq != null) {
      const evicted = evictOldest(sql, {
        userId,
        channelName,
        family,
        where: 'seq <= ?',
        bind: [Number(seqCap.seq)],
      });
      if (evicted !== null) evictedThrough = Math.max(evictedThrough ?? evicted, evicted);
    }
  }

  return evictedThrough;
}

/**
 * Prune a member's channel rows and persist the resulting overflow watermark
 * as one atomic operation. If either the deletes or the watermark write fails,
 * SQLite rolls the whole retention pass back so an undelivered row can never be
 * lost without the gap that describes it.
 */
export function pruneInboxRetentionAndBumpWatermark(
  sql: Pick<SQLProvider, 'exec' | 'transaction'>,
  params: PruneInboxRetentionAndBumpWatermarkParamsParameter,
): number | null {
  return sql.transaction(() => {
    const evictedThrough = pruneInboxRetentionRows(sql, params);
    if (evictedThrough === null) return null;

    bumpInboxWatermark(sql, {
      userId: params.userId,
      channelName: params.channelName,
      channelFamily: params.channelFamily,
      evictedThroughSeq: evictedThrough,
    });

    return evictedThrough;
  });
}

/** Delete the member's rows matching `where` and report the highest deleted seq. */
function evictOldest(sql: Pick<SQLProvider, 'exec'>, params: InboxEvictionParams): number | null {
  const { userId, channelName, family, where, bind } = params;
  const scope = [userId, channelName, family];
  const highest = sql
    .exec<{ seq: number | null }>(
      `
        SELECT MAX(seq) AS seq
        FROM __livething_inbox
        WHERE user_id = ? AND channel_name = ? AND channel_family = ? AND ${where}
      `,
      ...scope,
      ...bind,
    )
    .one();
  if (highest?.seq == null) return null;

  sql.exec(
    `
      DELETE FROM __livething_inbox
      WHERE user_id = ? AND channel_name = ? AND channel_family = ? AND ${where}
    `,
    ...scope,
    ...bind,
  );

  return Number(highest.seq);
}

/**
 * Raise a member's overflow watermark to the highest seq retention evicted, so a later drain knows the member missed everything up to that point.
 * Never lowers an existing watermark.
 */
export function bumpInboxWatermark(
  sql: Pick<SQLProvider, 'exec'>,
  params: InboxWatermarkParams,
): void {
  const { userId, channelName, channelFamily, evictedThroughSeq } = params;
  const family = familyToDb(channelFamily);
  const existing = sql
    .exec<{ evicted_through_seq: number }>(
      `
        SELECT evicted_through_seq FROM __livething_inbox_watermark
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
      INSERT OR REPLACE INTO __livething_inbox_watermark
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
        FROM __livething_inbox_watermark
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

/** Drop a member's channel watermark once an acknowledgement covers its gap. */
export function clearInboxWatermarkThrough(
  sql: Pick<SQLProvider, 'exec'>,
  params: InboxAckParams,
): void {
  sql.exec(
    `
      DELETE FROM __livething_inbox_watermark
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
  scopes: InboxScopeSet,
): void {
  const staticNames = new Set(scopes.staticNames);
  const familyKeys = new Set(scopes.familyKeys);

  sql.transaction(() => {
    // Do not put every active scope into one IN (...) list: a large contract
    // can exceed the adapter's bound-parameter limit. Stored scope pairs are
    // already the smallest set we need to inspect, and stale pairs are
    // removed one at a time inside the same transaction.
    const storedScopes = sql
      .exec<{ channel_name: string; channel_family: string }>(
        `
        SELECT channel_name, channel_family FROM __livething_inbox
        UNION
        SELECT channel_name, channel_family FROM __livething_inbox_watermark
        UNION
        SELECT channel_name, channel_family FROM __livething_inbox_receipts
      `,
      )
      .toArray();

    for (const scope of storedScopes) {
      const active =
        scope.channel_family === ''
          ? staticNames.has(scope.channel_name)
          : familyKeys.has(scope.channel_family);
      if (active) continue;

      sql.exec(
        `DELETE FROM __livething_inbox WHERE channel_name = ? AND channel_family = ?`,
        scope.channel_name,
        scope.channel_family,
      );
      sql.exec(
        `DELETE FROM __livething_inbox_watermark WHERE channel_name = ? AND channel_family = ?`,
        scope.channel_name,
        scope.channel_family,
      );
      sql.exec(
        `DELETE FROM __livething_inbox_receipts WHERE channel_name = ? AND channel_family = ?`,
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
  params: InboxChannelScope,
): void {
  sql.exec(
    `
      DELETE FROM __livething_inbox_watermark
      WHERE user_id = ? AND channel_name = ? AND channel_family = ?
    `,
    params.userId,
    params.channelName,
    familyToDb(params.channelFamily),
  );
}
