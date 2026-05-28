import { assertPositiveInteger } from '~/_engine/validation.ts';
import type { SQLProvider } from '~/context.ts';

const CREATE_SEQUENCE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_sequence (
    scope TEXT PRIMARY KEY,
    nextSeq INTEGER NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
  )
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

/** Default seq numbers reserved per SQL round-trip when batching is enabled. */
export const DEFAULT_SEQUENCE_BATCH_SIZE = 100;

/**
 * Claim one durable sequence number, bypassing the batch allocator.
 *
 * Kept for callers that explicitly want one-write-per-call semantics. Most
 * call sites should use `createPersistentSequenceAllocator(...)` instead — it
 * amortises the SQL write across a whole batch.
 */
export function allocatePersistentSequence(sql: SQLProvider): number {
  return sql.transaction((tx) => {
    const row = tx
      .exec<{
        nextSeq: number;
      }>('SELECT nextSeq FROM __wskit_sequence WHERE scope = ?', GLOBAL_SEQUENCE_SCOPE)
      .one();

    if (!row) {
      tx.exec(
        'INSERT INTO __wskit_sequence (scope, nextSeq) VALUES (?, ?)',
        GLOBAL_SEQUENCE_SCOPE,
        2,
      );

      return 1;
    }

    const nextSeq = Number(row.nextSeq);

    tx.exec(
      'UPDATE __wskit_sequence SET nextSeq = ? WHERE scope = ?',
      nextSeq + 1,
      GLOBAL_SEQUENCE_SCOPE,
    );

    return nextSeq;
  });
}

/**
 * Reserve `batchSize` seq numbers in one SQL transaction so subsequent
 * `next()` calls return from memory until the batch is exhausted.
 *
 * Trade-off: a crash mid-batch leaves the unused tail unallocated forever —
 * those seq numbers are never handed out, producing wire-level gaps. The
 * client side already treats gaps as "ask the server what's missing" rather
 * than "messages were lost", so the gaps are harmless. In exchange the SQL
 * write rate drops from 1-per-send to 1-per-batch (default 100×).
 *
 * Monotonic-and-unique guarantees still hold: the SQL row is bumped by the
 * full batch size before any number in the batch is returned, so a restart
 * always resumes above the reserved range.
 */
export function createPersistentSequenceAllocator(
  sql: SQLProvider,
  batchSize: number = DEFAULT_SEQUENCE_BATCH_SIZE,
): { next(): number } {
  assertPositiveInteger(batchSize, 'batchSize', 'sequence()');

  // The half-open range [cursor, ceiling) is the seq numbers reserved for this
  // wake but not yet handed out. Empty when cursor === ceiling — the next
  // `next()` call refills via SQL.
  let cursor = 0;
  let ceiling = 0;

  function reserveNextBatch(): void {
    const reserved = sql.transaction((tx) => {
      const row = tx
        .exec<{
          nextSeq: number;
        }>('SELECT nextSeq FROM __wskit_sequence WHERE scope = ?', GLOBAL_SEQUENCE_SCOPE)
        .one();

      const start = row ? Number(row.nextSeq) : 1;
      const end = start + batchSize;

      if (!row) {
        tx.exec(
          'INSERT INTO __wskit_sequence (scope, nextSeq) VALUES (?, ?)',
          GLOBAL_SEQUENCE_SCOPE,
          end,
        );
      } else {
        tx.exec(
          'UPDATE __wskit_sequence SET nextSeq = ? WHERE scope = ?',
          end,
          GLOBAL_SEQUENCE_SCOPE,
        );
      }

      return { start, end };
    });

    cursor = reserved.start;
    ceiling = reserved.end;
  }

  return {
    next(): number {
      if (cursor >= ceiling) reserveNextBatch();
      const value = cursor;
      cursor += 1;
      return value;
    },
  };
}
