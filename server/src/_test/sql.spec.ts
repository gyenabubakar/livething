import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it, vi } from 'vitest';

function recordStatements(sql: ReturnType<typeof createTestSql>): string[] {
  const statements: string[] = [];
  const run = sql.db.exec.bind(sql.db);
  vi.spyOn(sql.db, 'exec').mockImplementation((query: string) => {
    statements.push(query.trim());
    run(query);
  });

  return statements;
}

describe('createTestSql transaction', () => {
  it('begins a new top-level transaction after one that threw', () => {
    const sql = createTestSql();
    const statements = recordStatements(sql);

    expect(() =>
      sql.transaction(() => {
        throw new Error('callback failed');
      }),
    ).toThrow('callback failed');
    sql.transaction(() => {});

    expect(statements).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
  });

  it('begins a new top-level transaction after a nested one failed and the outer caught it', () => {
    const sql = createTestSql();
    const statements = recordStatements(sql);

    sql.transaction(() => {
      try {
        sql.transaction(() => {
          throw new Error('inner failed');
        });
      } catch {
        // the outer callback continues
      }
    });
    sql.transaction(() => {});

    expect(statements).toEqual([
      'BEGIN',
      'SAVEPOINT sp1',
      'ROLLBACK TO sp1; RELEASE sp1',
      'COMMIT',
      'BEGIN',
      'COMMIT',
    ]);
  });

  it('begins a new top-level transaction after a commit that failed', () => {
    const sql = createTestSql();
    sql.db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
    sql.db.exec(
      'CREATE TABLE child (pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)',
    );
    const statements = recordStatements(sql);

    expect(() => sql.transaction(() => sql.exec('INSERT INTO child VALUES (99)'))).toThrow(
      /FOREIGN KEY/,
    );
    sql.transaction(() => {});

    expect(statements).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK', 'BEGIN', 'COMMIT']);
    expect(sql.db.isTransaction).toBe(false);
  });

  it('does not try to roll back a transaction that SQLite already ended', () => {
    const sql = createTestSql();
    sql.db.exec('CREATE TABLE unique_rows (id INTEGER PRIMARY KEY)');
    sql.db.exec('INSERT INTO unique_rows VALUES (1)');

    expect(() =>
      sql.transaction(() => sql.exec('INSERT OR ROLLBACK INTO unique_rows VALUES (1)')),
    ).toThrow(/UNIQUE constraint failed/);
  });
});
