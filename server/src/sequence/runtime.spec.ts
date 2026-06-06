import { describe, expect, it } from 'vitest';
import {
  allocatePersistentSequence,
  createPersistentSequenceAllocator,
  ensureSequenceSchema,
} from './runtime.ts';

class FakeSqlResult<TRow = unknown> {
  constructor(private readonly row: Record<string, unknown> | null) {}

  toArray(): TRow[] {
    return this.row ? ([this.row] as TRow[]) : [];
  }

  one(): TRow | null {
    return this.row as TRow | null;
  }

  raw(): unknown[][] {
    return this.row ? [Object.values(this.row)] : [];
  }
}

function createSql() {
  const calls: string[] = [];
  let nextSeq: number | null = null;

  function exec<TRow = unknown>(query: string, ...params: unknown[]) {
    calls.push(query.replaceAll(/\s+/g, ' ').trim());

    if (query.includes('SELECT nextSeq')) {
      return new FakeSqlResult<TRow>(nextSeq == null ? null : { nextSeq });
    }

    if (query.includes('INSERT INTO __wskit_sequence')) {
      nextSeq = Number(params[1]);
      return new FakeSqlResult<TRow>(null);
    }

    if (query.includes('UPDATE __wskit_sequence')) {
      nextSeq = Number(params[0]);
      return new FakeSqlResult<TRow>(null);
    }

    return new FakeSqlResult<TRow>(null);
  }

  return {
    calls,
    sql: {
      exec,
      transaction<T>(fn: (tx: { exec: typeof exec }) => T): T {
        return fn({ exec });
      },
    },
  };
}

describe('sequence/runtime', () => {
  it('creates the durable sequence schema', () => {
    const { calls, sql } = createSql();

    ensureSequenceSchema(sql);

    expect(calls[0]).toContain('CREATE TABLE IF NOT EXISTS __wskit_sequence');
  });

  it('allocates persistent sequence numbers monotonically', () => {
    const { sql } = createSql();

    expect(allocatePersistentSequence(sql)).toBe(1);
    expect(allocatePersistentSequence(sql)).toBe(2);
    expect(allocatePersistentSequence(sql)).toBe(3);
  });

  it('resumes from a pre-existing sequence row after a restart', () => {
    // Simulate a server restart where the row already contains nextSeq=42.
    let currentSeq: number | null = 42;
    const queries: string[] = [];

    function exec<TRow = unknown>(query: string, ...params: unknown[]) {
      queries.push(query.replaceAll(/\s+/g, ' ').trim());

      if (query.includes('SELECT nextSeq')) {
        return new FakeSqlResult<TRow>(currentSeq == null ? null : { nextSeq: currentSeq });
      }

      if (query.includes('UPDATE __wskit_sequence')) {
        currentSeq = Number(params[0]);
        return new FakeSqlResult<TRow>(null);
      }

      return new FakeSqlResult<TRow>(null);
    }

    const sql = {
      exec,
      transaction<T>(fn: (tx: { exec: typeof exec }) => T): T {
        return fn({ exec });
      },
    };

    expect(allocatePersistentSequence(sql)).toBe(42);
    expect(allocatePersistentSequence(sql)).toBe(43);
    // No INSERT should happen when the row already exists.
    expect(queries.some((q) => q.startsWith('INSERT INTO __wskit_sequence'))).toBe(false);
  });
});

describe('createPersistentSequenceAllocator (batched)', () => {
  function writeCount(calls: string[]): number {
    return calls.filter(
      (q) => q.includes('__wskit_sequence') && (q.includes('INSERT') || q.includes('UPDATE')),
    ).length;
  }

  it('serves a whole batch from memory, hitting SQL only once per batch', () => {
    const { calls, sql } = createSql();
    const alloc = createPersistentSequenceAllocator(sql, 3); // batchSize 3

    // First next() reserves [1..4) in one write and serves from memory after.
    expect(alloc.next()).toBe(1);
    expect(alloc.next()).toBe(2);
    expect(alloc.next()).toBe(3);
    expect(writeCount(calls)).toBe(1); // the whole first batch was one SQL write

    // The 4th call exhausts the batch and refills with exactly one more write.
    expect(alloc.next()).toBe(4);
    expect(writeCount(calls)).toBe(2);
    expect(alloc.next()).toBe(5);
    expect(writeCount(calls)).toBe(2); // still serving the second batch from memory
  });

  it('respects a custom batchSize for when the refill happens', () => {
    const { calls, sql } = createSql();
    const alloc = createPersistentSequenceAllocator(sql, 2);

    expect(alloc.next()).toBe(1);
    expect(alloc.next()).toBe(2);
    expect(writeCount(calls)).toBe(1);
    expect(alloc.next()).toBe(3); // batch of 2 exhausted → refill
    expect(writeCount(calls)).toBe(2);
  });

  it('a restart resumes above the reserved range — monotonic with a gap (crash safety)', () => {
    const { sql } = createSql();
    const before = createPersistentSequenceAllocator(sql, 100);

    // Reserving the batch bumps the stored row to 101 BEFORE any number is given
    // out, then hands out 1, 2, 3 from memory.
    expect(before.next()).toBe(1);
    expect(before.next()).toBe(2);
    expect(before.next()).toBe(3);

    // Simulate a crash: the in-memory tail (4..100) is lost. A fresh allocator
    // reads the persisted row, which already jumped past the whole batch.
    const after = createPersistentSequenceAllocator(sql, 100);
    expect(after.next()).toBe(101); // never reuses 4..100 — strictly increasing
    expect(after.next()).toBe(102);
  });
});
