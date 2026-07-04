import { familyToDb } from '~/inbox/db-keys.ts';
import type { SQLProvider } from '~/context.ts';

const CREATE_RECEIPTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_inbox_receipts (
    channel_name     TEXT NOT NULL,
    channel_family   TEXT NOT NULL DEFAULT '',
    identity         TEXT NOT NULL,
    received_through INTEGER NOT NULL DEFAULT 0,
    seen_through     INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL,
    metadata         TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (channel_name, channel_family, identity)
  )
`;

const CREATE_RECEIPTS_SEEN_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_inbox_receipts_seen
  ON __wskit_inbox_receipts (channel_name, channel_family, seen_through)
`;

const RECEIPTS_SCHEMA_SQL = [CREATE_RECEIPTS_TABLE_SQL, CREATE_RECEIPTS_SEEN_INDEX_SQL].join(';\n');

/** Create the receipts cursor table and its seen-through index. Idempotent. */
export function ensureReceiptsSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(RECEIPTS_SCHEMA_SQL);
}

/** One member's receipt cursors for a channel. */
export interface ReceiptCursors {
  receivedThrough: number;
  seenThrough: number;
}

/** The settled cursors plus whether this advance actually moved them. */
export interface AdvancedCursors extends ReceiptCursors {
  changed: boolean;
}

function readCursors(
  sql: Pick<SQLProvider, 'exec'>,
  params: { channelName: string; channelFamily: string | null; identity: string },
): ReceiptCursors {
  const row = sql
    .exec<{ received_through: number; seen_through: number }>(
      `
        SELECT received_through, seen_through FROM __wskit_inbox_receipts
        WHERE channel_name = ? AND channel_family = ? AND identity = ?
      `,
      params.channelName,
      familyToDb(params.channelFamily),
      params.identity,
    )
    .one();
  return {
    receivedThrough: row ? Number(row.received_through) : 0,
    seenThrough: row ? Number(row.seen_through) : 0,
  };
}

/**
 * Advance a member's `received_through` cursor. Cumulative — a lower or equal
 * value is a no-op. `changed` tells the caller whether the cursor actually moved,
 * so a duplicate ack doesn't re-broadcast a `__receipt__`.
 */
export function advanceReceivedThrough(
  sql: Pick<SQLProvider, 'exec'>,
  params: {
    channelName: string;
    channelFamily: string | null;
    identity: string;
    receivedThrough: number;
    now: number;
  },
): AdvancedCursors {
  const current = readCursors(sql, params);
  const receivedThrough = Math.max(current.receivedThrough, params.receivedThrough);
  if (receivedThrough === current.receivedThrough) return { ...current, changed: false };

  writeCursors(sql, {
    channelName: params.channelName,
    channelFamily: params.channelFamily,
    identity: params.identity,
    receivedThrough,
    seenThrough: current.seenThrough,
    now: params.now,
  });
  return { receivedThrough, seenThrough: current.seenThrough, changed: true };
}

/**
 * Advance a member's `seen_through` cursor. Seen implies received, so
 * `received_through` is pulled up to at least `seen_through`, and `seen_through`
 * is clamped so it can never run ahead of what the member has received.
 * Cumulative and idempotent.
 */
export function advanceSeenThrough(
  sql: Pick<SQLProvider, 'exec'>,
  params: {
    channelName: string;
    channelFamily: string | null;
    identity: string;
    seenThrough: number;
    now: number;
  },
): AdvancedCursors {
  const current = readCursors(sql, params);
  const receivedThrough = Math.max(current.receivedThrough, params.seenThrough);
  const seenThrough = Math.min(Math.max(current.seenThrough, params.seenThrough), receivedThrough);

  if (receivedThrough === current.receivedThrough && seenThrough === current.seenThrough) {
    return { ...current, changed: false };
  }

  writeCursors(sql, {
    channelName: params.channelName,
    channelFamily: params.channelFamily,
    identity: params.identity,
    receivedThrough,
    seenThrough,
    now: params.now,
  });
  return { receivedThrough, seenThrough, changed: true };
}

function writeCursors(
  sql: Pick<SQLProvider, 'exec'>,
  params: {
    channelName: string;
    channelFamily: string | null;
    identity: string;
    receivedThrough: number;
    seenThrough: number;
    now: number;
  },
): void {
  sql.exec(
    `
      INSERT OR REPLACE INTO __wskit_inbox_receipts
        (channel_name, channel_family, identity, received_through, seen_through, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    params.channelName,
    familyToDb(params.channelFamily),
    params.identity,
    params.receivedThrough,
    params.seenThrough,
    params.now,
  );
}

/** Identities whose `received_through` has reached `seq`. Backs `receipts.receivedBy(seq)`. */
export function listReceivedBy(
  sql: Pick<SQLProvider, 'exec'>,
  params: { channelName: string; channelFamily: string | null; seq: number },
): string[] {
  return sql
    .exec<{ identity: string }>(
      `
        SELECT identity FROM __wskit_inbox_receipts
        WHERE channel_name = ? AND channel_family = ? AND received_through >= ?
      `,
      params.channelName,
      familyToDb(params.channelFamily),
      params.seq,
    )
    .toArray()
    .map((row) => row.identity);
}

/** Identities whose `seen_through` has reached `seq`. Backs `receipts.seenBy(seq)`. */
export function listSeenBy(
  sql: Pick<SQLProvider, 'exec'>,
  params: { channelName: string; channelFamily: string | null; seq: number },
): string[] {
  return sql
    .exec<{ identity: string }>(
      `
        SELECT identity FROM __wskit_inbox_receipts
        WHERE channel_name = ? AND channel_family = ? AND seen_through >= ?
      `,
      params.channelName,
      familyToDb(params.channelFamily),
      params.seq,
    )
    .toArray()
    .map((row) => row.identity);
}
