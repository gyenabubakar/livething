import { familyToDb } from '~/inbox/db-keys.ts';
import type { SQLProvider } from '~/context.ts';

const CREATE_RECEIPTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_inbox_receipts (
    channel_name     TEXT NOT NULL,
    channel_family   TEXT NOT NULL DEFAULT '',
    user_id          TEXT NOT NULL,
    received_through INTEGER NOT NULL DEFAULT 0,
    read_through     INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL,
    metadata         TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (channel_name, channel_family, user_id)
  )
`;

const CREATE_RECEIPTS_READ_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_inbox_receipts_read
  ON __wskit_inbox_receipts (channel_name, channel_family, read_through)
`;

// @__PURE__ lets the bundler drop this when unused; see channel/storage.ts.
const RECEIPTS_SCHEMA_SQL = /* @__PURE__ */ [
  CREATE_RECEIPTS_TABLE_SQL,
  CREATE_RECEIPTS_READ_INDEX_SQL,
].join(';\n');

/** Create the receipts cursor table and its read-through index. Idempotent. */
export function ensureReceiptsSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(RECEIPTS_SCHEMA_SQL);
}

/** One member's receipt cursors for a channel. */
export interface ReceiptCursors {
  receivedThrough: number;
  readThrough: number;
}

/**
 * Per-instance mirror of receipt cursors keyed by channel and user id. When
 * supplied, a cursor is read from memory instead of storage before an advance.
 */
export type ReceiptCursorCache = Map<string, ReceiptCursors>;

function cursorCacheKey(channelName: string, family: string | null, userId: string): string {
  return JSON.stringify([channelName, family, userId]);
}

/**
 * Remove every cache entry for one user from an inbox in-memory cache keyed by
 * `[channelName, channelFamily, userId]`. Used by `purgeUser`: purge deletes
 * the underlying rows, and a cache entry that outlives them would let a user
 * who reconnects on the same instance inherit stale cursors or counts from
 * before the purge.
 */
export function clearCacheEntriesForUser<V>(cache: Map<string, V>, userId: string): void {
  for (const key of cache.keys()) {
    try {
      const parsed: unknown = JSON.parse(key);
      if (Array.isArray(parsed) && parsed[2] === userId) cache.delete(key);
    } catch {
      // Ignore cache keys from unrelated maps.
    }
  }
}

/** The settled cursors plus whether this advance actually moved them. */
export interface AdvancedCursors extends ReceiptCursors {
  changed: boolean;
}

/**
 * A read advance's settled cursors, with a `changed` flag for the whole advance
 * and a separate `receivedChanged` flag. `readReceipts()` fans out `__received__`
 * only when read implied a received bump, so it needs to know that in isolation.
 */
export interface AdvancedReadCursors extends AdvancedCursors {
  receivedChanged: boolean;
}

interface ReceiptScope {
  channelName: string;
  channelFamily: string | null;
  userId: string;
}

interface ReceiptQuery extends Omit<ReceiptScope, 'channelFamily'> {
  family: string;
}

interface ReceivedAdvance extends ReceiptScope {
  receivedThrough: number;
  now: number;
}

interface ReadAdvance extends ReceiptScope {
  readThrough: number;
  now: number;
}

interface ReceiptWrite extends ReceiptScope {
  receivedThrough: number;
  readThrough: number;
  now: number;
}

interface ReceiptLookupScope extends Omit<ReceiptScope, 'userId'> {
  seq: number;
}

function readCursors(
  sql: Pick<SQLProvider, 'exec'>,
  params: ReceiptScope,
  cache?: ReceiptCursorCache,
): ReceiptCursors {
  const family = familyToDb(params.channelFamily);
  const query = { channelName: params.channelName, family, userId: params.userId };
  if (!cache) return queryCursors(sql, query);

  const key = cursorCacheKey(params.channelName, params.channelFamily, params.userId);
  const hit = cache.get(key);
  if (hit) return hit;

  const loaded = queryCursors(sql, query);
  cache.set(key, loaded);
  return loaded;
}

function queryCursors(sql: Pick<SQLProvider, 'exec'>, params: ReceiptQuery): ReceiptCursors {
  const row = sql
    .exec<{ received_through: number; read_through: number }>(
      `
        SELECT received_through, read_through FROM __wskit_inbox_receipts
        WHERE channel_name = ? AND channel_family = ? AND user_id = ?
      `,
      params.channelName,
      params.family,
      params.userId,
    )
    .one();
  return {
    receivedThrough: row ? Number(row.received_through) : 0,
    readThrough: row ? Number(row.read_through) : 0,
  };
}

/**
 * Advance a member's `received_through` cursor. Cumulative — a lower or equal
 * value is a no-op. `changed` tells the caller whether the cursor actually moved,
 * so a duplicate ack doesn't re-broadcast a `__received__` fan-out.
 */
export function advanceReceivedThrough(
  sql: Pick<SQLProvider, 'exec'>,
  params: ReceivedAdvance,
  cache?: ReceiptCursorCache,
): AdvancedCursors {
  const current = readCursors(sql, params, cache);
  const receivedThrough = Math.max(current.receivedThrough, params.receivedThrough);
  if (receivedThrough === current.receivedThrough) return { ...current, changed: false };

  writeCursors(
    sql,
    {
      channelName: params.channelName,
      channelFamily: params.channelFamily,
      userId: params.userId,
      receivedThrough,
      readThrough: current.readThrough,
      now: params.now,
    },
    cache,
  );
  return { receivedThrough, readThrough: current.readThrough, changed: true };
}

/**
 * Advance a member's `read_through` cursor. Read implies received, so
 * `received_through` is pulled up to at least `read_through`, and `read_through`
 * is clamped so it can never run ahead of what the member has received.
 * Cumulative and idempotent.
 */
export function advanceReadThrough(
  sql: Pick<SQLProvider, 'exec'>,
  params: ReadAdvance,
  cache?: ReceiptCursorCache,
): AdvancedReadCursors {
  const current = readCursors(sql, params, cache);
  const receivedThrough = Math.max(current.receivedThrough, params.readThrough);
  const readThrough = Math.min(Math.max(current.readThrough, params.readThrough), receivedThrough);
  const receivedChanged = receivedThrough !== current.receivedThrough;

  if (!receivedChanged && readThrough === current.readThrough) {
    return { ...current, changed: false, receivedChanged: false };
  }

  writeCursors(
    sql,
    {
      channelName: params.channelName,
      channelFamily: params.channelFamily,
      userId: params.userId,
      receivedThrough,
      readThrough,
      now: params.now,
    },
    cache,
  );
  return { receivedThrough, readThrough, changed: true, receivedChanged };
}

function writeCursors(
  sql: Pick<SQLProvider, 'exec'>,
  params: ReceiptWrite,
  cache?: ReceiptCursorCache,
): void {
  const family = familyToDb(params.channelFamily);
  sql.exec(
    `
      INSERT OR REPLACE INTO __wskit_inbox_receipts
        (channel_name, channel_family, user_id, received_through, read_through, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    params.channelName,
    family,
    params.userId,
    params.receivedThrough,
    params.readThrough,
    params.now,
  );
  cache?.set(cursorCacheKey(params.channelName, params.channelFamily, params.userId), {
    receivedThrough: params.receivedThrough,
    readThrough: params.readThrough,
  });
}

/** User ids whose `received_through` has reached `seq`. Backs `receiversOf(seq)`. */
export function listReceivers(
  sql: Pick<SQLProvider, 'exec'>,
  params: ReceiptLookupScope,
): string[] {
  return sql
    .exec<{ user_id: string }>(
      `
        SELECT user_id FROM __wskit_inbox_receipts
        WHERE channel_name = ? AND channel_family = ? AND received_through >= ?
      `,
      params.channelName,
      familyToDb(params.channelFamily),
      params.seq,
    )
    .toArray()
    .map((row) => row.user_id);
}

/** User ids whose `read_through` has reached `seq`. Backs `readersOf(seq)`. */
export function listReaders(sql: Pick<SQLProvider, 'exec'>, params: ReceiptLookupScope): string[] {
  return sql
    .exec<{ user_id: string }>(
      `
        SELECT user_id FROM __wskit_inbox_receipts
        WHERE channel_name = ? AND channel_family = ? AND read_through >= ?
      `,
      params.channelName,
      familyToDb(params.channelFamily),
      params.seq,
    )
    .toArray()
    .map((row) => row.user_id);
}
