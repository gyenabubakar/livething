import { chunkForBind } from '~/_engine/sql-batch.ts';
import type { SQLProvider } from '~/context.ts';

type StampLastSeenParamsParameter = { userId: string; now: number };

const CREATE_LAST_SEEN_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_last_seen (
    user_id      TEXT PRIMARY KEY,
    last_seen_at INTEGER NOT NULL,
    metadata     TEXT NOT NULL DEFAULT '{}'
  )
`;

/** Create the per-user last-seen table. Idempotent — safe on every boot. */
export function ensureLastSeenSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(CREATE_LAST_SEEN_TABLE_SQL);
}

/**
 * Stamp a user's last-seen timestamp. Cumulative — never lowers an existing
 * value, so an out-of-order write (e.g. a delayed disconnect) can't roll the mark
 * backwards.
 */
export function stampLastSeen(
  sql: Pick<SQLProvider, 'exec'>,
  params: StampLastSeenParamsParameter,
): void {
  if (!params.userId) return;

  sql.exec(
    `
      INSERT INTO __livething_last_seen (user_id, last_seen_at)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)
    `,
    params.userId,
    params.now,
  );
}

/** Read one user's last-seen timestamp (ms), or `null` when never stamped. */
export function readLastSeen(sql: Pick<SQLProvider, 'exec'>, userId: string): number | null {
  if (!userId) return null;

  const row = sql
    .exec<{
      last_seen_at: number;
    }>('SELECT last_seen_at FROM __livething_last_seen WHERE user_id = ?', userId)
    .one();
  return row ? Number(row.last_seen_at) : null;
}

/** Delete a user's last-seen row. Used by `purgeUser`. */
export function purgeLastSeenByUser(sql: Pick<SQLProvider, 'exec'>, userId: string): void {
  sql.exec('DELETE FROM __livething_last_seen WHERE user_id = ?', userId);
}

/**
 * Read last-seen timestamps for many users in one call, keyed by user id.
 * Splits the lookup into as many `WHERE user_id IN (...)` statements as the
 * adapter's bound-parameter cap requires, so a roster of any size — not just
 * one under the cap — comes back correctly.
 */
export function readLastSeenMany(
  sql: Pick<SQLProvider, 'exec' | 'limits'>,
  userIds: readonly string[],
): Map<string, number> {
  const wanted = userIds.filter((userId) => userId !== '');
  const result = new Map<string, number>();
  if (wanted.length === 0) return result;

  for (const batch of chunkForBind(wanted, 1, sql.limits)) {
    const placeholders = batch.map(() => '?').join(', ');
    const rows = sql
      .exec<{
        user_id: string;
        last_seen_at: number;
      }>(
        `SELECT user_id, last_seen_at FROM __livething_last_seen WHERE user_id IN (${placeholders})`,
        ...batch,
      )
      .toArray();
    for (const row of rows) result.set(String(row.user_id), Number(row.last_seen_at));
  }

  return result;
}
