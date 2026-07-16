import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it } from 'vitest';
import {
  allocatePersistentSequence,
  createPersistentSequenceAllocator,
  ensureSequenceSchema,
} from './runtime.ts';

// A real database plus a running log of the statements run against it, so a
// spec can both exercise the SQL for real and assert how many writes it took.
function sequenceDb() {
  const calls: string[] = [];
  const sql = createTestSql({
    onExec: (query) => calls.push(query.replaceAll(/\s+/g, ' ').trim()),
  });
  ensureSequenceSchema(sql);
  calls.length = 0;
  return { calls, sql };
}

describe('sequence/runtime', () => {
  it('creates the durable sequence schema', () => {
    const sql = createTestSql();
    ensureSequenceSchema(sql);

    const created = sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name);

    expect(created).toContain('__wskit_sequence');
  });

  it('allocates persistent sequence numbers monotonically', () => {
    const { sql } = sequenceDb();

    expect(allocatePersistentSequence(sql)).toBe(1);
    expect(allocatePersistentSequence(sql)).toBe(2);
    expect(allocatePersistentSequence(sql)).toBe(3);
  });

  it('resumes from a pre-existing sequence row after a restart', () => {
    const { calls, sql } = sequenceDb();
    sql.exec('INSERT INTO __wskit_sequence (scope, nextSeq) VALUES (?, ?)', 'global', 42);
    calls.length = 0;

    expect(allocatePersistentSequence(sql)).toBe(42);
    expect(allocatePersistentSequence(sql)).toBe(43);
    expect(calls.some((q) => q.startsWith('INSERT INTO __wskit_sequence'))).toBe(false);
  });
});

describe('createPersistentSequenceAllocator (batched)', () => {
  function writeCount(calls: string[]): number {
    return calls.filter(
      (q) => q.includes('__wskit_sequence') && (q.includes('INSERT') || q.includes('UPDATE')),
    ).length;
  }

  it('serves a whole batch from memory, hitting SQL only once per batch', () => {
    const { calls, sql } = sequenceDb();
    const alloc = createPersistentSequenceAllocator(sql, 3); // batchSize 3

    expect(alloc.next()).toBe(1);
    expect(alloc.next()).toBe(2);
    expect(alloc.next()).toBe(3);
    expect(writeCount(calls)).toBe(1); // the whole first batch was one SQL write

    expect(alloc.next()).toBe(4);
    expect(writeCount(calls)).toBe(2);
    expect(alloc.next()).toBe(5);
    expect(writeCount(calls)).toBe(2); // still serving the second batch from memory
  });

  it('respects a custom batchSize for when the refill happens', () => {
    const { calls, sql } = sequenceDb();
    const alloc = createPersistentSequenceAllocator(sql, 2);

    expect(alloc.next()).toBe(1);
    expect(alloc.next()).toBe(2);
    expect(writeCount(calls)).toBe(1);
    expect(alloc.next()).toBe(3); // batch of 2 exhausted → refill
    expect(writeCount(calls)).toBe(2);
  });

  it('a restart resumes above the reserved range — monotonic with a gap (crash safety)', () => {
    const { sql } = sequenceDb();
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
