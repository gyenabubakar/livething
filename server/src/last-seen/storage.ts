import type { SQLProvider } from '~/context.ts';

const CREATE_LAST_SEEN_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_last_seen (
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
  params: { userId: string; now: number },
): void {
  if (!params.userId) return;
  sql.exec(
    `
      INSERT INTO __wskit_last_seen (user_id, last_seen_at)
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
    }>('SELECT last_seen_at FROM __wskit_last_seen WHERE user_id = ?', userId)
    .one();
  return row ? Number(row.last_seen_at) : null;
}

/** Read last-seen timestamps for many users in one query, keyed by user id. */
export function readLastSeenMany(
  sql: Pick<SQLProvider, 'exec'>,
  userIds: readonly string[],
): Map<string, number> {
  const wanted = userIds.filter((userId) => userId !== '');
  const result = new Map<string, number>();
  if (wanted.length === 0) return result;

  const placeholders = wanted.map(() => '?').join(', ');
  const rows = sql
    .exec<{
      user_id: string;
      last_seen_at: number;
    }>(
      `SELECT user_id, last_seen_at FROM __wskit_last_seen WHERE user_id IN (${placeholders})`,
      ...wanted,
    )
    .toArray();
  for (const row of rows) result.set(String(row.user_id), Number(row.last_seen_at));
  return result;
}
