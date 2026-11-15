import { DatabaseSync } from 'node:sqlite';
import Database from 'better-sqlite3';
import { bench, describe } from 'vitest';
import { createSql } from './sql.ts';

// The queries an app and the engine run on every message or connection: one row by key, a
// few rows, and an upsert. Each driver gets the same table and the same queries.
const drivers = {
  'better-sqlite3': () => new Database(':memory:'),
  'node:sqlite': () => new DatabaseSync(':memory:'),
};

for (const [name, open] of Object.entries(drivers)) {
  describe(`sql.exec · ${name}`, () => {
    const { provider: sql } = createSql(open());
    sql.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, room TEXT NOT NULL, text TEXT NOT NULL)');
    sql.exec('CREATE INDEX messages_room ON messages (room)');
    for (let i = 0; i < 1000; i++) {
      sql.exec('INSERT INTO messages VALUES (?, ?, ?)', `m${i}`, `room:${i % 50}`, `hello ${i}`);
    }

    let n = 0;
    bench('read one row by key', () => {
      sql.exec('SELECT text FROM messages WHERE id = ?', `m${n++ % 1000}`).one();
    });

    bench('read 20 rows', () => {
      sql.exec('SELECT id, text FROM messages WHERE room = ?', `room:${n++ % 50}`).toArray();
    });

    bench('upsert one row', () => {
      sql.exec(
        'INSERT INTO messages VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text',
        `m${n++ % 1000}`,
        'room:0',
        'edited',
      );
    });
  });
}
