import { familyToDb } from '~/inbox/db-keys.ts';
import type { SQLProvider } from '~/context.ts';

const CREATE_RECEIPTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_inbox_receipts (
    channel_name     TEXT NOT NULL,
    channel_family   TEXT NOT NULL DEFAULT '',
    identity         TEXT NOT NULL,
    received_through INTEGER NOT NULL DEFAULT 0,
    read_through     INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL,
    metadata         TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (channel_name, channel_family, identity)
  )
`;

const CREATE_RECEIPTS_READ_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_inbox_receipts_read
  ON __wskit_inbox_receipts (channel_name, channel_family, read_through)
`;

const RECEIPTS_SCHEMA_SQL = [CREATE_RECEIPTS_TABLE_SQL, CREATE_RECEIPTS_READ_INDEX_SQL].join(';\n');

/** Create the receipts cursor table and its read-through index. Idempotent. */
export function ensureReceiptsSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(RECEIPTS_SCHEMA_SQL);
}

/** One member's receipt cursors for a channel. */
export interface ReceiptCursors {
  receivedThrough: number;
  readThrough: number;
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

function readCursors(
  sql: Pick<SQLProvider, 'exec'>,
  params: { channelName: string; channelFamily: string | null; identity: string },
): ReceiptCursors {
  const row = sql
    .exec<{ received_through: number; read_through: number }>(
      `
        SELECT received_through, read_through FROM __wskit_inbox_receipts
        WHERE channel_name = ? AND channel_family = ? AND identity = ?
      `,
      params.channelName,
      familyToDb(params.channelFamily),
      params.identity,
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
    readThrough: current.readThrough,
    now: params.now,
  });
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
  params: {
    channelName: string;
    channelFamily: string | null;
    identity: string;
    readThrough: number;
    now: number;
  },
): AdvancedReadCursors {
  const current = readCursors(sql, params);
  const receivedThrough = Math.max(current.receivedThrough, params.readThrough);
  const readThrough = Math.min(Math.max(current.readThrough, params.readThrough), receivedThrough);
  const receivedChanged = receivedThrough !== current.receivedThrough;

  if (!receivedChanged && readThrough === current.readThrough) {
    return { ...current, changed: false, receivedChanged: false };
  }

  writeCursors(sql, {
    channelName: params.channelName,
    channelFamily: params.channelFamily,
    identity: params.identity,
    receivedThrough,
    readThrough,
    now: params.now,
  });
  return { receivedThrough, readThrough, changed: true, receivedChanged };
}

function writeCursors(
  sql: Pick<SQLProvider, 'exec'>,
  params: {
    channelName: string;
    channelFamily: string | null;
    identity: string;
    receivedThrough: number;
    readThrough: number;
    now: number;
  },
): void {
  sql.exec(
    `
      INSERT OR REPLACE INTO __wskit_inbox_receipts
        (channel_name, channel_family, identity, received_through, read_through, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    params.channelName,
    familyToDb(params.channelFamily),
    params.identity,
    params.receivedThrough,
    params.readThrough,
    params.now,
  );
}

/** Identities whose `received_through` has reached `seq`. Backs `receiversOf(seq)`. */
export function listReceivers(
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

/** Identities whose `read_through` has reached `seq`. Backs `readersOf(seq)`. */
export function listReaders(
  sql: Pick<SQLProvider, 'exec'>,
  params: { channelName: string; channelFamily: string | null; seq: number },
): string[] {
  return sql
    .exec<{ identity: string }>(
      `
        SELECT identity FROM __wskit_inbox_receipts
        WHERE channel_name = ? AND channel_family = ? AND read_through >= ?
      `,
      params.channelName,
      familyToDb(params.channelFamily),
      params.seq,
    )
    .toArray()
    .map((row) => row.identity);
}
