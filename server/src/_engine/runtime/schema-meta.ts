import type { SQLProvider } from '~/context.ts';

/**
 * `__wskit_meta` marks whether this storage has been initialized before.
 * The schema-init hooks (`CREATE TABLE IF NOT EXISTS`) run on every boot
 * regardless — repeating them is cheap and guarantees a capability added
 * after storage was already initialized still gets its tables created on
 * the next boot. The marker exists only to tell a truly fresh database
 * (never initialized) from one that has been through at least one boot.
 */

interface SqlExec {
  exec<T = unknown>(query: string, ...params: unknown[]): { toArray(): T[] };
}

export interface SchemaState {
  /**
   * The meta table is absent, so storage has never been initialized. A
   * present table means this storage has booted before and may already
   * hold membership/tag rows. Used to decide whether the first auto-rejoin
   * can be safely skipped.
   */
  fresh: boolean;
}

/**
 * Check whether this storage has ever been initialized, in one round trip.
 * On a fresh instance the meta table does not exist yet — the SELECT throws
 * and we report `fresh: true`. The meta table itself is only created when
 * schema-init actually runs.
 */
export function readSchemaState(sql: SqlExec): SchemaState {
  try {
    sql.exec("SELECT value FROM __wskit_meta WHERE key = 'initialized'").toArray();
    return { fresh: false };
  } catch (error) {
    // Only a missing meta table means a truly fresh database. Any other storage
    // or query failure must propagate, not masquerade as fresh — which would
    // skip the first auto-rejoin even though membership rows exist.
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return { fresh: true };
    }
    throw error;
  }
}

/**
 * Create the meta table (if needed) and record that this storage has been
 * initialized. Bundled as one multi-statement exec so cold boot pays one
 * round trip.
 */
export function markSchemaInitialized(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS __wskit_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR REPLACE INTO __wskit_meta (key, value) VALUES ('initialized', '1')
  `);
}
