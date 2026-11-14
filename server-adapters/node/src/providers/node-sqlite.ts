import { Buffer } from 'node:buffer';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { SqliteDatabase, SqliteStatement } from './sql.ts';

/**
 * Whether a database the app passed is a `node:sqlite` `DatabaseSync`. It is told apart from a
 * better-sqlite3 database by its methods, so this package never imports `node:sqlite` itself.
 */
export function isNodeSqliteDatabase(source: object): source is DatabaseSync {
  return (
    typeof (source as DatabaseSync).prepare === 'function' &&
    typeof (source as DatabaseSync).exec === 'function' &&
    typeof (source as { pragma?: unknown }).pragma !== 'function'
  );
}

/**
 * Gives a `DatabaseSync` the few better-sqlite3 methods the SQL and KV providers use. It keeps
 * these better-sqlite3 rules for values: `undefined` binds NULL, other objects than bytes are
 * refused, and a BLOB comes back as a `Buffer`. One rule differs: reading an INTEGER above
 * 2^53 throws a `RangeError`, where better-sqlite3 rounds it.
 */
export function wrapNodeSqlite(database: DatabaseSync): SqliteDatabase {
  const probe = database.prepare('SELECT 1');
  if (typeof probe.columns !== 'function' || typeof probe.setReturnArrays !== 'function') {
    throw new TypeError(
      '[livething] A node:sqlite database needs Node.js 22.16 or newer. Update Node.js, or pass a better-sqlite3 database.',
    );
  }

  let depth = 0;

  return {
    prepare(query) {
      const statement = database.prepare(query);
      // prepare() compiles only the first statement. Throw for the rest, as better-sqlite3
      // does, so the SQL provider runs a parameter-free batch through exec().
      if (hasMoreStatements(query.trim().slice(statement.sourceSQL.trim().length))) {
        throw new RangeError('The supplied SQL string contains more than one statement');
      }

      return wrapStatement(statement);
    },
    exec: (query) => database.exec(query),
    close: () => database.close(),
    // node:sqlite has no transaction helper. A savepoint nests, and the outermost one is the
    // transaction itself, as with better-sqlite3's `transaction()`.
    transaction<T>(fn: () => T) {
      return () => {
        const savepoint = `livething_${depth}`;
        database.exec(`SAVEPOINT ${savepoint}`);
        depth += 1;
        try {
          const value = fn();
          database.exec(`RELEASE ${savepoint}`);

          return value;
        } catch (error) {
          try {
            database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          } catch {
            // The callback already ended the transaction. Its own error matters more.
          }

          throw error;
        } finally {
          depth -= 1;
        }
      };
    },
  };
}

function wrapStatement(statement: StatementSync): SqliteStatement {
  return {
    reader: statement.columns().length > 0,
    columns: () => statement.columns(),
    raw: () => ({
      all(...params) {
        statement.setReturnArrays(true);
        try {
          return statement
            .all(...bind(params))
            .map((row) => (row as unknown as unknown[]).map(toBuffer));
        } finally {
          statement.setReturnArrays(false);
        }
      },
    }),
    run: (...params) => statement.run(...bind(params)),
    get(...params) {
      const row = statement.get(...bind(params));
      return row && withBuffers(row);
    },
    all: (...params) => statement.all(...bind(params)).map(withBuffers),
  };
}

/** Whether the text after the first statement holds more than comments, `;` and spaces. */
function hasMoreStatements(rest: string): boolean {
  return rest.replace(/--[^\n]*|\/\*[\s\S]*?(\*\/|$)|[\s;]/g, '') !== '';
}

// node:sqlite reads a lone object as named parameters and drops it, so a Date would become NULL.
function bind(params: unknown[]): never[] {
  return params.map((value) => {
    if (value === undefined) return null;

    if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) {
      throw new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null');
    }

    return value;
  }) as never[];
}

function withBuffers(row: object): object {
  for (const [name, value] of Object.entries(row)) {
    (row as Record<string, unknown>)[name] = toBuffer(value);
  }

  return row;
}

function toBuffer(value: unknown): unknown {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value;
}
