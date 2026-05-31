import type { SQLProvider } from '~/context.ts';

/**
 * Schema-version marker row kept in the engine's storage so warm boots can skip
 * re-issuing every `CREATE TABLE IF NOT EXISTS` statement. Cold boots run
 * the full schema-init pile; later wakes read one row and skip the rest.
 *
 * Bump `CURRENT_SCHEMA_VERSION` whenever an `ensure*Schema` adds, drops, or
 * rewrites a table or index. Bumping forces every existing engine instance
 * to re-run the schema-init hooks on its next wake (a migration).
 */

const CURRENT_SCHEMA_VERSION = '1';

interface SqlExec {
  exec<T = unknown>(query: string, ...params: unknown[]): { toArray(): T[] };
}

/**
 * Returns `true` when storage records the current schema version. On a fresh
 * instance the meta table does not exist yet — the SELECT throws and we return
 * `false`. One round trip on the warm-boot path; the meta table itself is
 * only created when schema-init actually runs.
 */
export function isSchemaInitialized(sql: SqlExec): boolean {
  try {
    const rows = sql
      .exec<{ value: string }>("SELECT value FROM __wskit_meta WHERE key = 'schema_version'")
      .toArray();
    return rows.length > 0 && rows[0]?.value === CURRENT_SCHEMA_VERSION;
  } catch {
    // Meta table does not exist yet — treat as not initialized.
    return false;
  }
}

/**
 * Create the meta table (if needed) and write the current schema-version row.
 * Bundled as one multi-statement exec so cold boot pays one round trip.
 */
export function markSchemaInitialized(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(
    `
      CREATE TABLE IF NOT EXISTS __wskit_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR REPLACE INTO __wskit_meta (key, value) VALUES ('schema_version', ?)
    `,
    CURRENT_SCHEMA_VERSION,
  );
}
