/* oxlint-disable @typescript-eslint/no-explicit-any */
import { StreamIdCollision } from '@livething/core';
import { storedRowBytes, toBytes } from '~/_engine/runtime/stored-row.ts';

/**
 * Storage layer for recorded streams. `__livething_streams` has one row per
 * stream. `__livething_stream_chunks` stores the recorded chunks and cascades
 * when its stream row is deleted.
 */

const CREATE_STREAMS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_streams (
    user_id                   TEXT NOT NULL,
    stream_id                 TEXT NOT NULL,
    event                     TEXT NOT NULL,
    payload                   TEXT NOT NULL,
    status                    TEXT NOT NULL DEFAULT 'active',
    last_seq                  INTEGER NOT NULL DEFAULT 0,
    interrupted               INTEGER NOT NULL DEFAULT 0,
    channel_key               TEXT,
    channel_family             TEXT,
    broadcast                 INTEGER NOT NULL DEFAULT 0,
    creator_user_id           TEXT,
    last_activity_at          INTEGER NOT NULL,
    ended_at                  INTEGER,
    max_chunks                INTEGER,
    max_age_ms                INTEGER,
    retention_after_end_ms    INTEGER,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata                  TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, stream_id)
  )
`;

const CREATE_STREAMS_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __livething_idx_streams_status
  ON __livething_streams (status, last_activity_at)
`;

const CREATE_STREAM_CHUNKS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_stream_chunks (
    user_id      TEXT NOT NULL,
    stream_id    TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    message_id   TEXT,
    -- The chunk's JSON, or the info of a binary chunk.
    payload      TEXT NOT NULL,
    -- The bytes of a binary chunk, or NULL for a JSON chunk.
    binary_payload BLOB,
    -- The UTF-8 bytes of payload plus the bytes of binary_payload: what maxBufferBytes counts.
    row_bytes    INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata     TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, stream_id, seq),
    FOREIGN KEY (user_id, stream_id) REFERENCES __livething_streams (user_id, stream_id) ON DELETE CASCADE
  )
`;

// One row per subscriber of a broadcast stream: how far a reconnect has caught
// them up, and when they opted out (null while subscribed).
const CREATE_STREAM_SUBSCRIBERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_stream_subscribers (
    user_id              TEXT NOT NULL,
    stream_id            TEXT NOT NULL,
    subscriber_user_id   TEXT NOT NULL,
    caught_up_seq        INTEGER NOT NULL DEFAULT 0,
    unsubscribed_at      INTEGER,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata             TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, stream_id, subscriber_user_id),
    FOREIGN KEY (user_id, stream_id) REFERENCES __livething_streams (user_id, stream_id) ON DELETE CASCADE
  )
`;

/** Lifecycle state of a durable stream row. */
type DurableStreamStatus = 'active' | 'suspended' | 'ended';

/** One row from `__livething_streams`, decoded into typed fields. */
export interface DurableStreamRow {
  userId: string;
  streamId: string;
  event: string;
  payload: string;
  status: DurableStreamStatus;

  lastSeq: number;

  /** True when the stream ended without its generator finishing (it threw or stopped mid-stream). */
  interrupted: boolean;

  channelKey: string | null;
  channelFamily: string | null;

  broadcast: boolean;
  creatorUserId: string | null;

  lastActivityAt: number;
  endedAt: number | null;

  maxChunks: number | null;
  maxAgeMs: number | null;
  retentionAfterEndMs: number | null;
}

/** One row from `__livething_stream_chunks`, decoded into typed fields. */
export interface DurableStreamChunkRow {
  userId: string;
  streamId: string;

  seq: number;
  messageId: string | null;

  /** The chunk's JSON, or the info of a binary chunk. */
  payload: string;
  /** The bytes of a binary chunk, or `null` for a JSON chunk. */
  binaryPayload: Uint8Array | null;
}

interface SqlExec {
  exec(
    query: string,
    ...params: unknown[]
  ): {
    toArray(): Record<string, unknown>[];
  };
}

interface StreamRef {
  userId: string;
  streamId: string;
}

interface SubscriberRef {
  storageUserId: string;
  streamId: string;
  subscriberUserId: string;
}

// All statements (the PRAGMA + table/index CREATEs) bundled into one round
// trip. The PRAGMA is repeated every boot anyway since SQLite resets it
// per-connection, so it stays at the front of the bundle.
// @__PURE__ lets the bundler drop this when unused; see channel/storage.ts.
const DURABLE_STREAM_SCHEMA_SQL = /* @__PURE__ */ [
  'PRAGMA foreign_keys = ON',
  CREATE_STREAMS_TABLE_SQL,
  CREATE_STREAMS_STATUS_INDEX_SQL,
  CREATE_STREAM_CHUNKS_TABLE_SQL,
  CREATE_STREAM_SUBSCRIBERS_TABLE_SQL,
].join(';\n');

/** Create the durable stream tables and indexes if they do not yet exist. */
export function ensureDurableStreamSchema(sql: SqlExec): void {
  sql.exec(DURABLE_STREAM_SCHEMA_SQL);
}

function rowToStream(row: Record<string, unknown>): DurableStreamRow {
  return {
    userId: row.user_id as string,
    streamId: row.stream_id as string,
    event: row.event as string,
    payload: row.payload as string,
    status: row.status as DurableStreamStatus,
    lastSeq: Number(row.last_seq ?? 0),
    interrupted: Number(row.interrupted ?? 0) === 1,
    channelKey: (row.channel_key as string | null) ?? null,
    channelFamily: (row.channel_family as string | null) ?? null,
    broadcast: Number(row.broadcast ?? 0) === 1,
    creatorUserId: (row.creator_user_id as string | null) ?? null,
    lastActivityAt: Number(row.last_activity_at ?? 0),
    endedAt: row.ended_at == null ? null : Number(row.ended_at),
    maxChunks: row.max_chunks == null ? null : Number(row.max_chunks),
    maxAgeMs: row.max_age_ms == null ? null : Number(row.max_age_ms),
    retentionAfterEndMs:
      row.retention_after_end_ms == null ? null : Number(row.retention_after_end_ms),
  };
}

/** Inputs accepted by `insertStream`. */
export interface InsertStreamInput {
  userId: string;
  streamId: string;
  event: string;
  payload: string;
  now: number;

  channelKey?: string | null;
  channelFamily?: string | null;

  broadcast?: boolean;
  creatorUserId?: string | null;

  maxChunks?: number;
  maxAgeMs?: number;
  retentionAfterEndMs?: number;
}

/**
 * Throwing wrapper around the raw INSERT. The in-memory pre-insert collision
 * check upstream covers the common case, but a concurrent insert race on the
 * same (user_id, stream_id) hits the SQLite PRIMARY KEY constraint instead.
 * Surface that as `StreamIdCollision` so the dispatcher's catch turns it into
 * a typed __error__ frame.
 */
export function insertStream(sql: SqlExec, input: InsertStreamInput): void {
  try {
    sql.exec(
      `INSERT INTO __livething_streams
       (user_id, stream_id, event, payload, status, last_seq, channel_key, channel_family, broadcast, creator_user_id, last_activity_at, max_chunks, max_age_ms, retention_after_end_ms)
       VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.userId,
      input.streamId,
      input.event,
      input.payload,
      input.channelKey ?? null,
      input.channelFamily ?? null,
      input.broadcast ? 1 : 0,
      input.creatorUserId ?? null,
      input.now,
      input.maxChunks ?? null,
      input.maxAgeMs ?? null,
      input.retentionAfterEndMs ?? null,
    );
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw StreamIdCollision();
    }

    throw err;
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const msg = (err as { message?: unknown }).message;
  if (typeof msg !== 'string') return false;

  return (
    msg.includes('UNIQUE constraint') ||
    msg.includes('PRIMARY KEY') ||
    msg.includes('constraint failed')
  );
}

/** Read the row for one (userId, streamId), or `null` when no row matches. */
export function readStream(
  sql: SqlExec,
  userId: string,
  streamId: string,
): DurableStreamRow | null {
  const rows = sql
    .exec(
      'SELECT * FROM __livething_streams WHERE user_id = ? AND stream_id = ? LIMIT 1',
      userId,
      streamId,
    )
    .toArray();
  return rows.length > 0 ? rowToStream(rows[0]!) : null;
}

/** Persist the latest last_seq + activity timestamp. */
export function updateLastSeq(
  sql: SqlExec,
  opts: StreamRef & { lastSeq: number; now: number },
): void {
  const { userId, streamId, lastSeq, now } = opts;
  sql.exec(
    'UPDATE __livething_streams SET last_seq = ?, last_activity_at = ? WHERE user_id = ? AND stream_id = ?',
    lastSeq,
    now,
    userId,
    streamId,
  );
}

/** Move an active row to suspended so the sweep can age it out after `maxAgeMs`. */
export function markSuspended(sql: SqlExec, opts: StreamRef & { now: number }): void {
  const { userId, streamId, now } = opts;
  sql.exec(
    `UPDATE __livething_streams SET status = 'suspended', last_activity_at = ?
     WHERE user_id = ? AND stream_id = ? AND status = 'active'`,
    now,
    userId,
    streamId,
  );
}

/**
 * Suspend every row still marked active. Called when a new process starts: no
 * generator can be running yet, so an active row was left by a process that
 * stopped mid-stream. Once suspended, a client can still continue it and the
 * sweep expires it after `maxAgeMs`.
 */
export function suspendOrphanedStreams(sql: SqlExec, now: number): void {
  sql.exec(
    `UPDATE __livething_streams SET status = 'suspended', last_activity_at = ?
     WHERE status = 'active'`,
    now,
  );
}

/**
 * Mark a row ended and stamp `ended_at` so the retention window starts ticking.
 * Pass `interrupted: true` when the generator stopped without finishing, so a
 * later continue reports the cut-off instead of a normal end.
 */
export function markEnded(
  sql: SqlExec,
  opts: StreamRef & { now: number; interrupted?: boolean },
): void {
  const { userId, streamId, now, interrupted = false } = opts;
  sql.exec(
    `UPDATE __livething_streams SET status = 'ended', interrupted = ?, ended_at = ?, last_activity_at = ?
     WHERE user_id = ? AND stream_id = ?`,
    interrupted ? 1 : 0,
    now,
    now,
    userId,
    streamId,
  );
}

/** Delete the row and its chunks (ON DELETE CASCADE clears `__livething_stream_chunks`). */
export function deleteStream(sql: SqlExec, userId: string, streamId: string): void {
  sql.exec('DELETE FROM __livething_streams WHERE user_id = ? AND stream_id = ?', userId, streamId);
}

/** Inputs accepted by `appendChunk`. */
export interface AppendChunkInput {
  userId: string;
  streamId: string;

  seq: number;
  messageId: string | null;

  payload: string;
  /** The bytes of a binary chunk. */
  bytes?: Uint8Array;
}

/** Append one chunk to the buffer for replay on reconnect. */
export function appendChunk(sql: SqlExec, input: AppendChunkInput): void {
  sql.exec(
    `INSERT INTO __livething_stream_chunks
       (user_id, stream_id, seq, message_id, payload, binary_payload, row_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.userId,
    input.streamId,
    input.seq,
    input.messageId,
    input.payload,
    input.bytes ?? null,
    storedRowBytes(input.payload, input.bytes),
  );
}

/** Which chunks `readChunksSince` reads: those after `since`, one page of them. */
interface ChunkPage extends StreamRef {
  since: number;
  maxRows?: number;
  /** The page stops before the chunk that would take it over, but always has one chunk. */
  maxBytes?: number;
}

/**
 * Read the chunks with `seq > since`, ordered ascending, or one page of them. Used by continue
 * to send the tail again. With `maxBytes`, the sizes are read first, so a page of big binary
 * chunks is never read whole.
 */
export function readChunksSince(sql: SqlExec, opts: ChunkPage): DurableStreamChunkRow[] {
  const { userId, streamId, since } = opts;
  const where = 'WHERE user_id = ? AND stream_id = ? AND seq > ? ORDER BY seq ASC';
  let count = opts.maxRows ?? -1;
  if (opts.maxBytes !== undefined) {
    const sizes = sql
      .exec(
        `SELECT row_bytes FROM __livething_stream_chunks ${where} LIMIT ?`,
        userId,
        streamId,
        since,
        count,
      )
      .toArray();
    let bytes = 0;
    count = 0;
    for (const size of sizes) {
      bytes += Number(size.row_bytes);
      if (count > 0 && bytes > opts.maxBytes) break;

      count += 1;
    }

    if (count === 0) return [];
  }

  const rows = sql
    .exec(
      `SELECT * FROM __livething_stream_chunks ${where} LIMIT ?`,
      userId,
      streamId,
      since,
      count,
    )
    .toArray();

  return rows.map((row) => ({
    userId: row.user_id as string,
    streamId: row.stream_id as string,
    seq: Number(row.seq),
    messageId: (row.message_id as string | null) ?? null,
    payload: row.payload as string,
    binaryPayload: toBytes(row.binary_payload),
  }));
}

/** What one stream's buffer holds: how many chunks, and their `row_bytes` together. */
export interface BufferedChunks {
  chunks: number;
  bytes: number;
}

/** Count the chunks buffered for one stream, and their bytes. Used to enforce the buffer limits. */
export function countChunks(sql: SqlExec, userId: string, streamId: string): BufferedChunks {
  const rows = sql
    .exec(
      'SELECT COUNT(*) AS n, SUM(row_bytes) AS b FROM __livething_stream_chunks WHERE user_id = ? AND stream_id = ?',
      userId,
      streamId,
    )
    .toArray();
  return { chunks: Number(rows[0]?.n ?? 0), bytes: Number(rows[0]?.b ?? 0) };
}

/** One subscriber's standing in a broadcast stream. */
export interface StreamSubscriber {
  /** Highest chunk seq a reconnect has caught this subscriber up to. */
  caughtUpSeq: number;

  /** When the subscriber opted out, or `null` while subscribed. */
  unsubscribedAt: number | null;
}

/** Add a subscriber row at caught-up seq 0. No-op when the row exists. */
export function seedSubscriber(sql: SqlExec, opts: SubscriberRef): void {
  const { storageUserId, streamId, subscriberUserId } = opts;
  sql.exec(
    `INSERT OR IGNORE INTO __livething_stream_subscribers
     (user_id, stream_id, subscriber_user_id, caught_up_seq)
     VALUES (?, ?, ?, 0)`,
    storageUserId,
    streamId,
    subscriberUserId,
  );
}

/** Record how far a reconnect caught a subscriber up. Upserts the row. */
export function setCaughtUpSeq(sql: SqlExec, opts: SubscriberRef & { caughtUpSeq: number }): void {
  const { storageUserId, streamId, subscriberUserId, caughtUpSeq } = opts;
  sql.exec(
    `INSERT INTO __livething_stream_subscribers
     (user_id, stream_id, subscriber_user_id, caught_up_seq)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, stream_id, subscriber_user_id)
     DO UPDATE SET caught_up_seq = excluded.caught_up_seq`,
    storageUserId,
    streamId,
    subscriberUserId,
    caughtUpSeq,
  );
}

/** Read a subscriber's standing, or `null` when they have no row. */
export function getSubscriber(sql: SqlExec, opts: SubscriberRef): StreamSubscriber | null {
  const { storageUserId, streamId, subscriberUserId } = opts;
  const row = sql
    .exec(
      `SELECT caught_up_seq, unsubscribed_at FROM __livething_stream_subscribers
       WHERE user_id = ? AND stream_id = ? AND subscriber_user_id = ? LIMIT 1`,
      storageUserId,
      streamId,
      subscriberUserId,
    )
    .toArray()[0];
  if (!row) return null;

  return {
    caughtUpSeq: Number(row.caught_up_seq),
    unsubscribedAt: row.unsubscribed_at == null ? null : Number(row.unsubscribed_at),
  };
}

/** Record that `subscriberUserId` opted out of a broadcast stream. */
export function markUnsubscribed(sql: SqlExec, opts: SubscriberRef & { now: number }): void {
  const { storageUserId, streamId, subscriberUserId, now } = opts;
  sql.exec(
    `INSERT INTO __livething_stream_subscribers
     (user_id, stream_id, subscriber_user_id, unsubscribed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, stream_id, subscriber_user_id)
     DO UPDATE SET unsubscribed_at = excluded.unsubscribed_at`,
    storageUserId,
    streamId,
    subscriberUserId,
    now,
  );
}

/** True when `subscriberUserId` previously cancelled out of the broadcast. */
export function isUnsubscribed(sql: SqlExec, opts: SubscriberRef): boolean {
  return getSubscriber(sql, opts)?.unsubscribedAt != null;
}

/** Identifier pair returned by sweep queries, ready to pass to `deleteStream`. */
export interface SweepCandidate {
  userId: string;
  streamId: string;
}

/** Suspended streams that have aged past `maxAgeMs` from `last_activity_at`. */
export function findExpiredSuspended(sql: SqlExec, now: number): SweepCandidate[] {
  const rows = sql
    .exec(
      `SELECT user_id, stream_id FROM __livething_streams
     WHERE status = 'suspended'
       AND max_age_ms IS NOT NULL
       AND (last_activity_at + max_age_ms) < ?`,
      now,
    )
    .toArray();
  return rows.map((row) => ({
    userId: row.user_id as string,
    streamId: row.stream_id as string,
  }));
}

/** Options accepted by {@link purgeStreamsByUser}. */
export interface PurgeStreamsByUserOptions {
  /**
   * Keep the content of broadcast streams the user created — the channel-owned
   * stream row plus its recorded chunks and subscriber rows. Default `false`:
   * that content is deleted along with everything else the user owns. Either
   * way, `creator_user_id` is cleared on every row the user created, since a
   * purged user can never stay on record as a stream's creator.
   */
  keepBroadcastContent?: boolean;
}

/** Read a stream this user started. A broadcast stream is filed under its channel, not the user. */
export function readStreamOfCreator(
  sql: SqlExec,
  creatorUserId: string,
  streamId: string,
): DurableStreamRow | null {
  const row = sql
    .exec(
      'SELECT user_id FROM __livething_streams WHERE stream_id = ? AND (user_id = ? OR creator_user_id = ?)',
      streamId,
      creatorUserId,
      creatorUserId,
    )
    .toArray()[0];

  return row ? readStream(sql, row.user_id as string, streamId) : null;
}

/**
 * Delete every durable-stream row a user owns, plus their chunks and
 * subscriber rows, plus every row where they merely subscribe to someone
 * else's broadcast stream. Used by `purgeUser`. Explicit — does not rely on
 * `ON DELETE CASCADE` being enforced by the storage backend.
 *
 * A broadcast stream is filed under a synthetic channel key in `user_id`, not
 * under its creator's id, so it needs its own pass keyed off
 * `creator_user_id`. That pass reads the affected `(user_id, stream_id)` pairs
 * before deleting anything — the parent row is the only handle to its chunks
 * and subscribers, so losing it first would strand them.
 */
export function purgeStreamsByUser(
  sql: SqlExec,
  userId: string,
  options?: PurgeStreamsByUserOptions,
): void {
  if (options?.keepBroadcastContent) {
    sql.exec(
      'UPDATE __livething_streams SET creator_user_id = NULL WHERE creator_user_id = ?',
      userId,
    );
  } else {
    const createdRows = sql
      .exec('SELECT user_id, stream_id FROM __livething_streams WHERE creator_user_id = ?', userId)
      .toArray();
    for (const row of createdRows) {
      const streamUserId = row.user_id as string;
      const streamId = row.stream_id as string;
      sql.exec(
        'DELETE FROM __livething_stream_chunks WHERE user_id = ? AND stream_id = ?',
        streamUserId,
        streamId,
      );
      sql.exec(
        'DELETE FROM __livething_stream_subscribers WHERE user_id = ? AND stream_id = ?',
        streamUserId,
        streamId,
      );
    }

    sql.exec('DELETE FROM __livething_streams WHERE creator_user_id = ?', userId);
  }

  sql.exec('DELETE FROM __livething_stream_chunks WHERE user_id = ?', userId);
  sql.exec('DELETE FROM __livething_stream_subscribers WHERE user_id = ?', userId);
  sql.exec('DELETE FROM __livething_stream_subscribers WHERE subscriber_user_id = ?', userId);
  sql.exec('DELETE FROM __livething_streams WHERE user_id = ?', userId);
}

/** Ended streams whose retention window has elapsed since `ended_at`. */
export function findExpiredEnded(sql: SqlExec, now: number): SweepCandidate[] {
  const rows = sql
    .exec(
      `SELECT user_id, stream_id FROM __livething_streams
     WHERE status = 'ended'
       AND ended_at IS NOT NULL
       AND retention_after_end_ms IS NOT NULL
       AND (ended_at + retention_after_end_ms) < ?`,
      now,
    )
    .toArray();
  return rows.map((row) => ({
    userId: row.user_id as string,
    streamId: row.stream_id as string,
  }));
}
