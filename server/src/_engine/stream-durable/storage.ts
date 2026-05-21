/* oxlint-disable @typescript-eslint/no-explicit-any */
import { StreamIdCollision } from '@wskit/core';

/**
 * Storage layer for durable streams. Two tables keyed by
 * `(identity, stream_id)`: `_wskit_streams` (one row per stream) and
 * `_wskit_stream_chunks` (recorded streams only, ON DELETE CASCADE).
 */

const CREATE_STREAMS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _wskit_streams (
    identity                  TEXT NOT NULL,
    stream_id                 TEXT NOT NULL,
    event                     TEXT NOT NULL,
    payload                   TEXT NOT NULL,
    kind                      TEXT NOT NULL,
    status                    TEXT NOT NULL DEFAULT 'active',
    cursor                    TEXT,
    last_seq                  INTEGER NOT NULL DEFAULT 0,
    namespace                 TEXT,
    channel_key               TEXT,
    channel_scope             TEXT,
    broadcast                 INTEGER NOT NULL DEFAULT 0,
    creator_identity          TEXT,
    started_at                INTEGER NOT NULL,
    last_activity_at          INTEGER NOT NULL,
    ended_at                  INTEGER,
    max_chunks                INTEGER,
    max_age_ms                INTEGER,
    retention_after_end_ms    INTEGER,
    PRIMARY KEY (identity, stream_id)
  )
`;

const CREATE_STREAMS_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_wskit_streams_status
  ON _wskit_streams (status, last_activity_at)
`;

const CREATE_STREAM_CHUNKS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _wskit_stream_chunks (
    identity     TEXT NOT NULL,
    stream_id    TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    message_id   TEXT,
    payload      TEXT NOT NULL,
    emitted_at   INTEGER NOT NULL,
    PRIMARY KEY (identity, stream_id, seq),
    FOREIGN KEY (identity, stream_id) REFERENCES _wskit_streams (identity, stream_id) ON DELETE CASCADE
  )
`;

// Tracks identities that opted out of a broadcast stream via `__streamCancel__`.
// The fanout step skips identities listed here; their resume returns
// stream-aborted unsubscribed.
const CREATE_STREAM_UNSUBSCRIBED_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _wskit_stream_unsubscribed (
    identity             TEXT NOT NULL,
    stream_id            TEXT NOT NULL,
    subscriber_identity  TEXT NOT NULL,
    unsubscribed_at      INTEGER NOT NULL,
    PRIMARY KEY (identity, stream_id, subscriber_identity),
    FOREIGN KEY (identity, stream_id) REFERENCES _wskit_streams (identity, stream_id) ON DELETE CASCADE
  )
`;

/** Which durable-stream primitive owns the row. */
export type DurableStreamKind = 'resumable' | 'recorded';

/** Lifecycle state of a durable stream row. */
export type DurableStreamStatus = 'active' | 'suspended' | 'ended';

/** One row from `_wskit_streams`, decoded into typed fields. */
export interface DurableStreamRow {
  identity: string;
  streamId: string;
  event: string;
  payload: string;
  kind: DurableStreamKind;
  status: DurableStreamStatus;
  cursor: string | null;
  lastSeq: number;
  namespace: string | null;
  channelKey: string | null;
  channelScope: string | null;
  broadcast: boolean;
  creatorIdentity: string | null;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  maxChunks: number | null;
  maxAgeMs: number | null;
  retentionAfterEndMs: number | null;
}

/** One row from `_wskit_stream_chunks`, decoded into typed fields. */
export interface DurableStreamChunkRow {
  identity: string;
  streamId: string;
  seq: number;
  messageId: string | null;
  payload: string;
  emittedAt: number;
}

interface SqlExec {
  exec(
    query: string,
    ...params: unknown[]
  ): {
    toArray(): Record<string, unknown>[];
  };
}

/** Create the durable stream tables and indexes if they do not yet exist. */
export function ensureDurableStreamSchema(sql: SqlExec): void {
  // FK enforcement on — cascade delete clears chunks on row removal.
  sql.exec('PRAGMA foreign_keys = ON');
  sql.exec(CREATE_STREAMS_TABLE_SQL);
  sql.exec(CREATE_STREAMS_STATUS_INDEX_SQL);
  sql.exec(CREATE_STREAM_CHUNKS_TABLE_SQL);
  sql.exec(CREATE_STREAM_UNSUBSCRIBED_TABLE_SQL);
}

function rowToStream(row: Record<string, unknown>): DurableStreamRow {
  return {
    identity: row.identity as string,
    streamId: row.stream_id as string,
    event: row.event as string,
    payload: row.payload as string,
    kind: row.kind as DurableStreamKind,
    status: row.status as DurableStreamStatus,
    cursor: (row.cursor as string | null) ?? null,
    lastSeq: Number(row.last_seq ?? 0),
    namespace: (row.namespace as string | null) ?? null,
    channelKey: (row.channel_key as string | null) ?? null,
    channelScope: (row.channel_scope as string | null) ?? null,
    broadcast: Number(row.broadcast ?? 0) === 1,
    creatorIdentity: (row.creator_identity as string | null) ?? null,
    startedAt: Number(row.started_at ?? 0),
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
  identity: string;
  streamId: string;
  event: string;
  payload: string;
  kind: DurableStreamKind;
  now: number;
  namespace?: string | null;
  channelKey?: string | null;
  channelScope?: string | null;
  broadcast?: boolean;
  creatorIdentity?: string | null;
  maxChunks?: number;
  maxAgeMs?: number;
  retentionAfterEndMs?: number;
}

/**
 * Throwing wrapper around the raw INSERT. The in-memory pre-insert collision
 * check upstream covers the common case, but a concurrent insert race on the
 * same (identity, stream_id) hits the SQLite PRIMARY KEY constraint instead.
 * Surface that as `StreamIdCollision` so the dispatcher's catch turns it into
 * a typed __error__ frame.
 */
export function insertStream(sql: SqlExec, input: InsertStreamInput): void {
  try {
    sql.exec(
      `INSERT INTO _wskit_streams
       (identity, stream_id, event, payload, kind, status, last_seq, namespace, channel_key, channel_scope, broadcast, creator_identity, started_at, last_activity_at, max_chunks, max_age_ms, retention_after_end_ms)
       VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.identity,
      input.streamId,
      input.event,
      input.payload,
      input.kind,
      input.namespace ?? null,
      input.channelKey ?? null,
      input.channelScope ?? null,
      input.broadcast ? 1 : 0,
      input.creatorIdentity ?? null,
      input.now,
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

/** Read the row for one (identity, streamId), or `null` when no row matches. */
export function readStream(
  sql: SqlExec,
  identity: string,
  streamId: string,
): DurableStreamRow | null {
  const rows = sql
    .exec(
      'SELECT * FROM _wskit_streams WHERE identity = ? AND stream_id = ? LIMIT 1',
      identity,
      streamId,
    )
    .toArray();
  return rows.length > 0 ? rowToStream(rows[0]!) : null;
}

/** Persist the latest cursor + last_seq + activity timestamp for a resumable stream. */
export function updateCursor(
  sql: SqlExec,
  identity: string,
  streamId: string,
  cursor: string,
  lastSeq: number,
  now: number,
): void {
  sql.exec(
    'UPDATE _wskit_streams SET cursor = ?, last_seq = ?, last_activity_at = ? WHERE identity = ? AND stream_id = ?',
    cursor,
    lastSeq,
    now,
    identity,
    streamId,
  );
}

/** Persist the latest last_seq + activity timestamp. Used when no cursor is yielded. */
export function updateLastSeq(
  sql: SqlExec,
  identity: string,
  streamId: string,
  lastSeq: number,
  now: number,
): void {
  sql.exec(
    'UPDATE _wskit_streams SET last_seq = ?, last_activity_at = ? WHERE identity = ? AND stream_id = ?',
    lastSeq,
    now,
    identity,
    streamId,
  );
}

/** Move an active row to suspended so the sweep can age it out after `maxAgeMs`. */
export function markSuspended(sql: SqlExec, identity: string, streamId: string, now: number): void {
  sql.exec(
    `UPDATE _wskit_streams SET status = 'suspended', last_activity_at = ?
     WHERE identity = ? AND stream_id = ? AND status = 'active'`,
    now,
    identity,
    streamId,
  );
}

/** Mark a row ended and stamp `ended_at` so the retention window starts ticking. */
export function markEnded(sql: SqlExec, identity: string, streamId: string, now: number): void {
  sql.exec(
    `UPDATE _wskit_streams SET status = 'ended', ended_at = ?, last_activity_at = ?
     WHERE identity = ? AND stream_id = ?`,
    now,
    now,
    identity,
    streamId,
  );
}

/** Delete the row and its chunks (ON DELETE CASCADE clears `_wskit_stream_chunks`). */
export function deleteStream(sql: SqlExec, identity: string, streamId: string): void {
  sql.exec('DELETE FROM _wskit_streams WHERE identity = ? AND stream_id = ?', identity, streamId);
}

/** Inputs accepted by `appendChunk`. */
export interface AppendChunkInput {
  identity: string;
  streamId: string;
  seq: number;
  messageId: string | null;
  payload: string;
  now: number;
}

/** Append one chunk to the buffer for replay on resume. */
export function appendChunk(sql: SqlExec, input: AppendChunkInput): void {
  sql.exec(
    `INSERT INTO _wskit_stream_chunks (identity, stream_id, seq, message_id, payload, emitted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.identity,
    input.streamId,
    input.seq,
    input.messageId,
    input.payload,
    input.now,
  );
}

/** Read chunks with `seq > since`, ordered ascending. Used by resume to replay the tail. */
export function readChunksSince(
  sql: SqlExec,
  identity: string,
  streamId: string,
  since: number,
): DurableStreamChunkRow[] {
  const rows = sql
    .exec(
      `SELECT * FROM _wskit_stream_chunks
     WHERE identity = ? AND stream_id = ? AND seq > ?
     ORDER BY seq ASC`,
      identity,
      streamId,
      since,
    )
    .toArray();
  return rows.map((row) => ({
    identity: row.identity as string,
    streamId: row.stream_id as string,
    seq: Number(row.seq),
    messageId: (row.message_id as string | null) ?? null,
    payload: row.payload as string,
    emittedAt: Number(row.emitted_at),
  }));
}

/** Count chunks currently buffered for one stream. Used to enforce `maxChunks`. */
export function countChunks(sql: SqlExec, identity: string, streamId: string): number {
  const rows = sql
    .exec(
      'SELECT COUNT(*) AS n FROM _wskit_stream_chunks WHERE identity = ? AND stream_id = ?',
      identity,
      streamId,
    )
    .toArray();
  return Number(rows[0]?.n ?? 0);
}

/** Delete the oldest chunks so only `keepNewest` remain. No-op if already within cap. */
export function trimOldestChunks(
  sql: SqlExec,
  identity: string,
  streamId: string,
  keepNewest: number,
): void {
  sql.exec(
    `DELETE FROM _wskit_stream_chunks
     WHERE identity = ? AND stream_id = ?
       AND seq IN (
         SELECT seq FROM _wskit_stream_chunks
         WHERE identity = ? AND stream_id = ?
         ORDER BY seq ASC
         LIMIT MAX(0, (SELECT COUNT(*) FROM _wskit_stream_chunks WHERE identity = ? AND stream_id = ?) - ?)
       )`,
    identity,
    streamId,
    identity,
    streamId,
    identity,
    streamId,
    keepNewest,
  );
}

/** Record that `subscriberIdentity` opted out of a broadcast stream. */
export function markUnsubscribed(
  sql: SqlExec,
  storageIdentity: string,
  streamId: string,
  subscriberIdentity: string,
  now: number,
): void {
  sql.exec(
    `INSERT OR IGNORE INTO _wskit_stream_unsubscribed
     (identity, stream_id, subscriber_identity, unsubscribed_at)
     VALUES (?, ?, ?, ?)`,
    storageIdentity,
    streamId,
    subscriberIdentity,
    now,
  );
}

/** True when `subscriberIdentity` previously cancelled out of the broadcast. */
export function isUnsubscribed(
  sql: SqlExec,
  storageIdentity: string,
  streamId: string,
  subscriberIdentity: string,
): boolean {
  const rows = sql
    .exec(
      `SELECT 1 AS hit FROM _wskit_stream_unsubscribed
       WHERE identity = ? AND stream_id = ? AND subscriber_identity = ? LIMIT 1`,
      storageIdentity,
      streamId,
      subscriberIdentity,
    )
    .toArray();
  return rows.length > 0;
}

/** Identifier pair returned by sweep queries, ready to pass to `deleteStream`. */
export interface SweepCandidate {
  identity: string;
  streamId: string;
}

/** Suspended streams that have aged past `maxAgeMs` from `last_activity_at`. */
export function findExpiredSuspended(sql: SqlExec, now: number): SweepCandidate[] {
  const rows = sql
    .exec(
      `SELECT identity, stream_id FROM _wskit_streams
     WHERE status = 'suspended'
       AND max_age_ms IS NOT NULL
       AND (last_activity_at + max_age_ms) < ?`,
      now,
    )
    .toArray();
  return rows.map((row) => ({
    identity: row.identity as string,
    streamId: row.stream_id as string,
  }));
}

/** Ended streams whose retention window has elapsed since `ended_at`. */
export function findExpiredEnded(sql: SqlExec, now: number): SweepCandidate[] {
  const rows = sql
    .exec(
      `SELECT identity, stream_id FROM _wskit_streams
     WHERE status = 'ended'
       AND ended_at IS NOT NULL
       AND retention_after_end_ms IS NOT NULL
       AND (ended_at + retention_after_end_ms) < ?`,
      now,
    )
    .toArray();
  return rows.map((row) => ({
    identity: row.identity as string,
    streamId: row.stream_id as string,
  }));
}
