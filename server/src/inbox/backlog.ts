import { familyToDb } from '~/inbox/db-keys.ts';
import type { SQLProvider } from '~/context.ts';

/** One member's raw backlog figures for a channel, read straight from SQL. */
export interface InboxBacklogRow {
  identity: string;
  heldRows: number;
  receivedThrough: number;
  oldestHeldAt: number;
}

/**
 * Read one row per member that still holds unacked inbox rows for a channel:
 * the held-row count, the member's `received_through` cursor, and the oldest
 * held row's `created_at`. Joins `__wskit_inbox` (held rows) against
 * `__wskit_inbox_receipts` (the cursor) so a member with no cursor row still
 * reports `received_through` as 0. Backs `handle.inbox().backlog()`.
 */
export function loadInboxBacklog(
  sql: Pick<SQLProvider, 'exec'>,
  params: { channelName: string; channelFamily: string | null },
): InboxBacklogRow[] {
  const family = familyToDb(params.channelFamily);
  return sql
    .exec<{
      identity: string;
      held_rows: number;
      received_through: number | null;
      oldest_held_at: number;
    }>(
      `
        SELECT
          inbox.identity                       AS identity,
          COUNT(*)                             AS held_rows,
          MIN(inbox.created_at)                AS oldest_held_at,
          MAX(COALESCE(receipts.received_through, 0)) AS received_through
        FROM __wskit_inbox AS inbox
        LEFT JOIN __wskit_inbox_receipts AS receipts
          ON receipts.channel_name = inbox.channel_name
          AND receipts.channel_family = inbox.channel_family
          AND receipts.identity = inbox.identity
        WHERE inbox.channel_name = ? AND inbox.channel_family = ? AND inbox.delivered_at IS NULL
        GROUP BY inbox.identity
        ORDER BY inbox.identity ASC
      `,
      params.channelName,
      family,
    )
    .toArray()
    .map((row) => ({
      identity: String(row.identity),
      heldRows: Number(row.held_rows),
      receivedThrough: row.received_through == null ? 0 : Number(row.received_through),
      oldestHeldAt: Number(row.oldest_held_at),
    }));
}
