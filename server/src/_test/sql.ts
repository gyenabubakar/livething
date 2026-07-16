import { DatabaseSync } from 'node:sqlite';
import type { SQLProvider, SqlResult } from '~/context.ts';

/** Options for {@link createTestSql}. */
export interface TestSqlOptions {
  /**
   * Called with the raw query and params on every `exec`, including the ones a
   * `transaction()` callback runs. Lets a spec count real writes without giving
   * up a real database — used where "how many statements ran" is the invariant.
   */
  onExec?: (query: string, params: readonly unknown[]) => void;
}

/**
 * A real in-memory SQLite database, wired to the `SQLProvider` contract, for
 * any storage test that should exercise the actual SQL rather than a hand-rolled
 * fake. The storage layer leans on `MAX(seq)`, `OFFSET`, `GROUP BY`,
 * `INSERT OR REPLACE`, foreign-key cascades, and primary-key constraints that a
 * fake can only guess at, so these specs run against the engine Node ships.
 *
 * A statement starting with `SELECT` or `WITH` is read as a query; anything else
 * is a write. A write may bundle several `;`-separated statements (a schema
 * batch) — the leading statements run unparameterized and the params bind onto
 * the last one.
 */
export function createTestSql(options: TestSqlOptions = {}): SQLProvider & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');

  function exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
    options.onExec?.(query, params);
    const trimmed = query.trim();

    if (/^\s*(SELECT|WITH)/i.test(trimmed)) {
      const rows = db.prepare(trimmed).all(...(params as never[])) as TRow[];
      return {
        toArray: () => rows,
        one() {
          if (rows.length > 1) throw new Error('.one() saw more than one row');
          return rows[0] ?? null;
        },
        raw: () => rows.map((row) => Object.values(row as Record<string, unknown>)),
      };
    }

    const statements = trimmed
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    const last = statements.pop()!;
    for (const statement of statements) db.exec(statement);
    db.prepare(last).run(...(params as never[]));
    return emptyResult<TRow>();
  }

  return {
    db,
    exec,
    transaction<T>(fn: (tx: { exec: typeof exec }) => T): T {
      db.exec('BEGIN');
      try {
        const result = fn({ exec });
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function emptyResult<TRow>(): SqlResult<TRow> {
  return { toArray: () => [], one: () => null, raw: () => [] };
}
