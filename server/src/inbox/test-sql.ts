import { DatabaseSync } from 'node:sqlite';
import type { SQLProvider, SqlResult } from '~/context.ts';

/**
 * A real in-memory SQLite adapter for inbox/receipts storage tests. The storage
 * layer leans on `MAX(seq)`, `OFFSET`, and `INSERT OR REPLACE` semantics a
 * hand-rolled fake can't model faithfully, so these specs run against the real
 * engine node ships.
 */
export function createTestSql(): SQLProvider & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');

  function exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
    const trimmed = query.trim();
    const isRead = /^\s*(SELECT|WITH)/i.test(trimmed);

    if (!isRead) {
      // Schema init batches several statements with `;`; run those directly.
      if (trimmed.includes(';')) db.exec(trimmed);
      else db.prepare(trimmed).run(...(params as never[]));
      return emptyResult<TRow>();
    }

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

  return {
    db,
    exec,
    transaction<T>(fn: (tx: { exec: typeof exec }) => T): T {
      return fn({ exec });
    },
  };
}

function emptyResult<TRow>(): SqlResult<TRow> {
  return { toArray: () => [], one: () => null, raw: () => [] };
}
