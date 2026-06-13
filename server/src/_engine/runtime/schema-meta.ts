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

export interface SchemaState {
  /** Storage records the current schema version — schema-init can be skipped. */
  initialized: boolean;
  /**
   * The meta table is absent, so storage has never been initialized. A present
   * table with an older version is a migration, not a fresh DB, and may already
   * hold membership/tag rows. Used to decide whether the first auto-rejoin can
   * be safely skipped.
   */
  fresh: boolean;
}

/**
 * Read the schema marker in one round trip. On a fresh instance the meta table
 * does not exist yet — the SELECT throws and we report `fresh: true`. The meta
 * table itself is only created when schema-init actually runs.
 */
export function readSchemaState(sql: SqlExec): SchemaState {
  try {
    const rows = sql
      .exec<{ value: string }>("SELECT value FROM __wskit_meta WHERE key = 'schema_version'")
      .toArray();
    return {
      initialized: rows.length > 0 && rows[0]?.value === CURRENT_SCHEMA_VERSION,
      fresh: false,
    };
  } catch (error) {
    // Only a missing meta table means a truly fresh database. Any other storage
    // or query failure must propagate, not masquerade as fresh — which would
    // skip the first auto-rejoin even though membership rows exist.
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return { initialized: false, fresh: true };
    }
    throw error;
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
