import { assertPositiveInteger } from '~/_engine/validation.ts';
import type { SQLProvider } from '~/context.ts';

const CREATE_SEQUENCE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_sequence (
    scope TEXT PRIMARY KEY,
    nextSeq INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata TEXT NOT NULL DEFAULT '{}'
  )
`;

const GLOBAL_SEQUENCE_SCOPE = 'global';

/**
 * Create the SQLite table used by durable sequence numbers.
 *
 * LiveThing keeps a single row here with the next `seq` number that has not been
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
  return sql.transaction(() => {
    const row = sql
      .exec<{
        nextSeq: number;
      }>('SELECT nextSeq FROM __livething_sequence WHERE scope = ?', GLOBAL_SEQUENCE_SCOPE)
      .one();

    if (!row) {
      sql.exec(
        'INSERT INTO __livething_sequence (scope, nextSeq) VALUES (?, ?)',
        GLOBAL_SEQUENCE_SCOPE,
        2,
      );

      return 1;
    }

    const nextSeq = Number(row.nextSeq);

    sql.exec(
      'UPDATE __livething_sequence SET nextSeq = ? WHERE scope = ?',
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
 * always continues above the reserved range.
 */
export function createPersistentSequenceAllocator(
  sql: SQLProvider,
  batchSize: number = DEFAULT_SEQUENCE_BATCH_SIZE,
): { next(): number } {
  assertPositiveInteger(batchSize, 'batchSize', 'sequence()');

  // The half-open range [cursor, ceiling) is the seq numbers reserved for this
  // `next()` call refills via SQL.
  let cursor = 0;
  let ceiling = 0;

  function reserveNextBatch(): void {
    const reserved = sql.transaction(() => {
      const row = sql
        .exec<{
          nextSeq: number;
        }>('SELECT nextSeq FROM __livething_sequence WHERE scope = ?', GLOBAL_SEQUENCE_SCOPE)
        .one();

      const start = row ? Number(row.nextSeq) : 1;
      const end = start + batchSize;

      if (!row) {
        sql.exec(
          'INSERT INTO __livething_sequence (scope, nextSeq) VALUES (?, ?)',
          GLOBAL_SEQUENCE_SCOPE,
          end,
        );
      } else {
        sql.exec(
          'UPDATE __livething_sequence SET nextSeq = ? WHERE scope = ?',
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
