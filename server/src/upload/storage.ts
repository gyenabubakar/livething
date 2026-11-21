/**
 * Storage for uploads: one row per upload in `__livething_uploads`, keyed by the user and the
 * upload id. The row keeps what a resume needs (the input, the saved offset and the app's
 * state) and, once the upload is done, the reply.
 */

export interface SqlExec {
  exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] };
}

/**
 * - `active`: the upload can still start or resume.
 * - `done`: `run` returned. The row keeps the reply for a short time, so a client that lost
 *   the reply gets it again.
 * - `discarding`: the upload ended without finishing. `onDiscard` still has to run.
 */
type UploadStatus = 'active' | 'done' | 'discarding';

export interface UploadRow {
  userId: string;
  uploadId: string;
  event: string;
  /** The input, as JSON. */
  input: string;
  /** The total size the client sent at the start, or `null`. */
  size: number | null;
  savedThrough: number;
  /** The app's state from `ctx.upload.saved()`, as JSON, or `null`. */
  state: string | null;
  status: UploadStatus;
  /** The reply's info as JSON, once the upload is done. */
  reply: string | null;
  updatedAt: number;
}

const CREATE_UPLOADS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_uploads (
    user_id        TEXT NOT NULL,
    upload_id      TEXT NOT NULL,
    event          TEXT NOT NULL,
    input          TEXT NOT NULL,
    size           INTEGER,
    saved_through  INTEGER NOT NULL DEFAULT 0,
    state          TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    reply          TEXT,
    updated_at     INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata       TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, upload_id)
  )
`;

const CREATE_UPLOADS_UPDATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __livething_idx_uploads_updated
  ON __livething_uploads (updated_at)
`;

export function ensureUploadSchema(sql: SqlExec): void {
  sql.exec(CREATE_UPLOADS_TABLE_SQL);
  sql.exec(CREATE_UPLOADS_UPDATED_INDEX_SQL);
}

function toRow(raw: Record<string, unknown>): UploadRow {
  return {
    userId: raw.user_id as string,
    uploadId: raw.upload_id as string,
    event: raw.event as string,
    input: raw.input as string,
    size: raw.size === null ? null : Number(raw.size),
    savedThrough: Number(raw.saved_through),
    state: (raw.state as string | null) ?? null,
    status: raw.status as UploadStatus,
    reply: (raw.reply as string | null) ?? null,
    updatedAt: Number(raw.updated_at),
  };
}

export function readUpload(sql: SqlExec, userId: string, uploadId: string): UploadRow | undefined {
  const raw = sql
    .exec('SELECT * FROM __livething_uploads WHERE user_id = ? AND upload_id = ?', userId, uploadId)
    .toArray()[0];
  return raw ? toRow(raw) : undefined;
}

export function insertUpload(
  sql: SqlExec,
  row: Pick<UploadRow, 'userId' | 'uploadId' | 'event' | 'input' | 'size' | 'updatedAt'>,
): void {
  sql.exec(
    `INSERT INTO __livething_uploads (user_id, upload_id, event, input, size, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    row.userId,
    row.uploadId,
    row.event,
    row.input,
    row.size,
    row.updatedAt,
  );
}

/** The key of one upload's row. */
export interface UploadKey {
  userId: string;
  uploadId: string;
}

/** A `ctx.upload.saved()` call: the offset, and the state's JSON when it was given. */
interface UploadProgress {
  savedThrough: number;
  state: string | null | undefined;
  now: number;
}

/** A finished upload: its total and its reply's JSON. */
interface UploadDone {
  savedThrough: number;
  reply: string;
  now: number;
}

export function saveUploadProgress(sql: SqlExec, key: UploadKey, progress: UploadProgress): void {
  if (progress.state === undefined) {
    sql.exec(
      `UPDATE __livething_uploads SET saved_through = ?, updated_at = ?
       WHERE user_id = ? AND upload_id = ? AND status = 'active'`,
      progress.savedThrough,
      progress.now,
      key.userId,
      key.uploadId,
    );
    return;
  }

  sql.exec(
    `UPDATE __livething_uploads SET saved_through = ?, state = ?, updated_at = ?
     WHERE user_id = ? AND upload_id = ? AND status = 'active'`,
    progress.savedThrough,
    progress.state,
    progress.now,
    key.userId,
    key.uploadId,
  );
}

export function touchUpload(sql: SqlExec, key: UploadKey, now: number): void {
  sql.exec(
    `UPDATE __livething_uploads SET updated_at = ?
     WHERE user_id = ? AND upload_id = ? AND status = 'active'`,
    now,
    key.userId,
    key.uploadId,
  );
}

export function finishUpload(sql: SqlExec, key: UploadKey, done: UploadDone): void {
  sql.exec(
    `UPDATE __livething_uploads SET status = 'done', saved_through = ?, reply = ?, state = NULL,
       updated_at = ?
     WHERE user_id = ? AND upload_id = ?`,
    done.savedThrough,
    done.reply,
    done.now,
    key.userId,
    key.uploadId,
  );
}

export function markUploadDiscarding(sql: SqlExec, key: UploadKey, now: number): void {
  sql.exec(
    `UPDATE __livething_uploads SET status = 'discarding', updated_at = ?
     WHERE user_id = ? AND upload_id = ? AND status != 'done'`,
    now,
    key.userId,
    key.uploadId,
  );
}

export function deleteUpload(sql: SqlExec, key: UploadKey): void {
  sql.exec(
    'DELETE FROM __livething_uploads WHERE user_id = ? AND upload_id = ?',
    key.userId,
    key.uploadId,
  );
}

/** Mark every upload of a user that is not done as `discarding`, and delete the done ones. */
export function purgeUploadsOfUser(sql: SqlExec, userId: string, now: number): void {
  sql.exec("DELETE FROM __livething_uploads WHERE user_id = ? AND status = 'done'", userId);
  sql.exec(
    "UPDATE __livething_uploads SET status = 'discarding', updated_at = ? WHERE user_id = ?",
    now,
    userId,
  );
}

/** How long a row of each status waits before the sweep handles it. */
export interface UploadTimes {
  /** An `active` upload with no pieces and no `saved()` for this long expires. */
  idleMs: number;
  /** A `done` row keeps its reply this long. */
  doneMs: number;
  /** A `discarding` row whose `onDiscard` threw waits this long before the next try. */
  retryMs: number;
}

const DEADLINE_SQL = `CASE status
  WHEN 'active' THEN updated_at + ?
  WHEN 'done' THEN updated_at + ?
  ELSE updated_at + ? END`;

/** Which due rows one sweep reads: those due by `now`, at most `limit`. */
interface SweepWindow {
  now: number;
  limit: number;
}

/** When one row's time comes. */
interface UploadDeadline extends UploadKey {
  deadline: number;
}

/** The rows whose time has come, oldest first, at most `limit`. */
export function dueUploads(sql: SqlExec, times: UploadTimes, options: SweepWindow): UploadRow[] {
  return sql
    .exec(
      `SELECT * FROM __livething_uploads WHERE ${DEADLINE_SQL} <= ?
       ORDER BY ${DEADLINE_SQL} LIMIT ?`,
      times.idleMs,
      times.doneMs,
      times.retryMs,
      options.now,
      times.idleMs,
      times.doneMs,
      times.retryMs,
      options.limit,
    )
    .toArray()
    .map(toRow);
}

/** The earliest deadlines, with each row's key, at most `limit`. */
export function nextUploadDeadlines(
  sql: SqlExec,
  times: UploadTimes,
  limit: number,
): UploadDeadline[] {
  return sql
    .exec(
      `SELECT user_id, upload_id, ${DEADLINE_SQL} AS deadline FROM __livething_uploads
       ORDER BY deadline LIMIT ?`,
      times.idleMs,
      times.doneMs,
      times.retryMs,
      limit,
    )
    .toArray()
    .map((raw) => ({
      userId: raw.user_id as string,
      uploadId: raw.upload_id as string,
      deadline: Number(raw.deadline),
    }));
}
