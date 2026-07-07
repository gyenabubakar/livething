import type { SQLProvider } from '~/context.ts';

const CREATE_LAST_SEEN_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_last_seen (
    identity     TEXT PRIMARY KEY,
    last_seen_at INTEGER NOT NULL,
    metadata     TEXT NOT NULL DEFAULT '{}'
  )
`;

/** Create the per-identity last-seen table. Idempotent — safe on every boot. */
export function ensureLastSeenSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(CREATE_LAST_SEEN_TABLE_SQL);
}

/**
 * Stamp an identity's last-seen timestamp. Cumulative — never lowers an existing
 * value, so an out-of-order write (e.g. a delayed disconnect) can't roll the mark
 * backwards.
 */
export function stampLastSeen(
  sql: Pick<SQLProvider, 'exec'>,
  params: { identity: string; now: number },
): void {
  if (!params.identity) return;
  sql.exec(
    `
      INSERT INTO __wskit_last_seen (identity, last_seen_at)
      VALUES (?, ?)
      ON CONFLICT(identity) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)
    `,
    params.identity,
    params.now,
  );
}

/** Read one identity's last-seen timestamp (ms), or `null` when never stamped. */
export function readLastSeen(sql: Pick<SQLProvider, 'exec'>, identity: string): number | null {
  if (!identity) return null;
  const row = sql
    .exec<{
      last_seen_at: number;
    }>('SELECT last_seen_at FROM __wskit_last_seen WHERE identity = ?', identity)
    .one();
  return row ? Number(row.last_seen_at) : null;
}

/** Read last-seen timestamps for many identities in one query, keyed by identity. */
export function readLastSeenMany(
  sql: Pick<SQLProvider, 'exec'>,
  identities: readonly string[],
): Map<string, number> {
  const wanted = identities.filter((identity) => identity !== '');
  const result = new Map<string, number>();
  if (wanted.length === 0) return result;

  const placeholders = wanted.map(() => '?').join(', ');
  const rows = sql
    .exec<{
      identity: string;
      last_seen_at: number;
    }>(
      `SELECT identity, last_seen_at FROM __wskit_last_seen WHERE identity IN (${placeholders})`,
      ...wanted,
    )
    .toArray();
  for (const row of rows) result.set(String(row.identity), Number(row.last_seen_at));
  return result;
}
