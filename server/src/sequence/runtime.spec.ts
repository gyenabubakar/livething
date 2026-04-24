import { describe, expect, it } from 'vitest';
import { allocatePersistentSequence, ensureSequenceSchema } from './runtime.ts';

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

    if (query.includes('INSERT INTO _wskit_sequence')) {
      nextSeq = Number(params[1]);
      return new FakeSqlResult<TRow>(null);
    }

    if (query.includes('UPDATE _wskit_sequence')) {
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

    expect(calls[0]).toContain('CREATE TABLE IF NOT EXISTS _wskit_sequence');
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

      if (query.includes('UPDATE _wskit_sequence')) {
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
    expect(queries.some((q) => q.startsWith('INSERT INTO _wskit_sequence'))).toBe(false);
  });
});
