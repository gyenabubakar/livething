import type { SQLProvider } from '~/context.ts';

const CREATE_SEQUENCE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _wskit_sequence (
    scope TEXT PRIMARY KEY,
    nextSeq INTEGER NOT NULL
  )
`;

const SELECT_SEQUENCE_SQL = `
  SELECT nextSeq
  FROM _wskit_sequence
  WHERE scope = ?
`;

const INSERT_SEQUENCE_SQL = `
  INSERT INTO _wskit_sequence (
    scope,
    nextSeq
  ) VALUES (?, ?)
`;

const UPDATE_SEQUENCE_SQL = `
  UPDATE _wskit_sequence
  SET nextSeq = ?
  WHERE scope = ?
`;

const GLOBAL_SEQUENCE_SCOPE = 'global';

/**
 * Create the SQLite table used by durable sequence numbers.
 *
 * wskit keeps a single row here with the next `seq` number that has not been
 * handed out yet.
 */
export function ensureSequenceSchema(sql: SQLProvider): void {
  sql.exec(CREATE_SEQUENCE_TABLE_SQL);
}

/**
 * Claim the next durable sequence number.
 *
 * This happens inside one SQL transaction so two outgoing messages cannot read
 * and reuse the same number.
 */
export function allocatePersistentSequence(sql: SQLProvider): number {
  return sql.transaction((tx) => {
    const row = tx.exec<{ nextSeq: number }>(SELECT_SEQUENCE_SQL, GLOBAL_SEQUENCE_SCOPE).one();

    if (!row) {
      tx.exec(INSERT_SEQUENCE_SQL, GLOBAL_SEQUENCE_SCOPE, 2);

      return 1;
    }

    const nextSeq = Number(row.nextSeq);

    tx.exec(UPDATE_SEQUENCE_SQL, nextSeq + 1, GLOBAL_SEQUENCE_SCOPE);

    return nextSeq;
  });
}
