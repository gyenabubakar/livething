import { emits, server, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

function selectNotes(ctx: {
  sql: { exec: <TRow = unknown>(sql: string, ...params: unknown[]) => { toArray: () => TRow[] } };
}) {
  return ctx.sql
    .exec<{
      id: number;
      title: string;
      body: string;
    }>('SELECT id, title, body FROM notes ORDER BY id DESC')
    .toArray();
}

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      'notes-list': t<{ notes: Array<{ id: number; title: string; body: string }> }>(),
      'sql-one-result': t<{ row: { c: number } | null }>(),
      'sql-one-empty-result': t<{ row: { c: number } | null }>(),
      'sql-raw-result': t<{ rows: unknown[][] }>(),
      'sql-reuse-result': t<{ error: string }>(),
      'snapshot-result': t<{ count: number; shapeOk: boolean }>(),
    }),
  ],
});

base.onInit((ctx) => {
  ctx.sql.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL
    )
  `);
});

const handleSaveNote = base.on('save-note', {
  input: v.object({ title: v.string(), body: v.string() }),
  run(ctx, input) {
    ctx.sql.exec('INSERT INTO notes (title, body) VALUES (?, ?)', input.title, input.body);
    ctx.send('notes-list', { notes: selectNotes(ctx) });
  },
});

const handleGetNotes = base.on('get-notes', {
  input: v.object({}),
  run(ctx) {
    ctx.send('notes-list', { notes: selectNotes(ctx) });
  },
});

const handleSqlOneProbe = base.on('sql-one-probe', {
  input: v.object({}),
  run(ctx) {
    const row = ctx.sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM notes').one();
    ctx.send('sql-one-result', { row: row ? { c: Number(row.c) } : null });
  },
});

const handleSqlRawProbe = base.on('sql-raw-probe', {
  input: v.object({}),
  run(ctx) {
    const rows = ctx.sql.exec('SELECT id, title FROM notes ORDER BY id DESC').raw();
    ctx.send('sql-raw-result', { rows: rows as unknown[][] });
  },
});

const handleSqlReuseProbe = base.on('sql-reuse-probe', {
  input: v.object({}),
  run(ctx) {
    const result = ctx.sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM notes');
    result.one();

    let error = '';
    try {
      result.toArray();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    ctx.send('sql-reuse-result', { error });
  },
});

const handleSqlOneEmptyProbe = base.on('sql-one-empty-probe', {
  input: v.object({}),
  run(ctx) {
    const row = ctx.sql.exec<{ c: number }>('SELECT id AS c FROM notes WHERE id = -999').one();
    ctx.send('sql-one-empty-result', { row: row ? { c: Number(row.c) } : null });
  },
});

const handleSqlTxCommitProbe = base.on('sql-tx-commit-probe', {
  input: v.object({}),
  run(ctx) {
    ctx.sql.transaction((tx) => {
      tx.exec('INSERT INTO notes (title, body) VALUES (?, ?)', 'tx-a', 'a');
      tx.exec('INSERT INTO notes (title, body) VALUES (?, ?)', 'tx-b', 'b');
    });
    ctx.send('notes-list', { notes: selectNotes(ctx) });
  },
});

const handleSqlTxRollbackProbe = base.on('sql-tx-rollback-probe', {
  input: v.object({}),
  run(ctx) {
    try {
      ctx.sql.transaction((tx) => {
        tx.exec('INSERT INTO notes (title, body) VALUES (?, ?)', 'tx-rollback', 'x');
        throw new Error('roll it back');
      });
    } catch {
      // expected — the transaction rethrows after rolling back.
    }

    ctx.send('notes-list', { notes: selectNotes(ctx) });
  },
});

const handleSqlOneMultiProbe = base.on('sql-one-multi-probe', {
  input: v.object({}),
  run(ctx) {
    ctx.sql.exec('INSERT INTO notes (title, body) VALUES (?, ?)', 'm1', 'x');
    ctx.sql.exec('INSERT INTO notes (title, body) VALUES (?, ?)', 'm2', 'x');

    let error = '';
    try {
      ctx.sql.exec('SELECT id FROM notes').one();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    ctx.send('sql-reuse-result', { error });
  },
});

const handleConnectionsSnapshotProbe = base.on('connections-snapshot-probe', {
  input: v.object({}),
  run(ctx) {
    const conns = ctx.connections.all();
    const c = conns[0];
    const shapeOk =
      !!c &&
      typeof c.id === 'string' &&
      c.id.length > 0 &&
      typeof c.userId === 'string' &&
      typeof c.meta === 'object' &&
      Array.isArray(c.channels) &&
      Array.isArray(c.tags) &&
      (c.latency === null || typeof c.latency === 'number') &&
      (c.quality === null || typeof c.quality === 'string') &&
      typeof c.bufferedAmount === 'number';

    ctx.send('snapshot-result', { count: conns.length, shapeOk });
  },
});

export const ctxSqlDefinition = base.assemble({
  handlers: [
    handleSaveNote,
    handleGetNotes,
    handleSqlOneProbe,
    handleSqlRawProbe,
    handleSqlReuseProbe,
    handleSqlOneEmptyProbe,
    handleSqlTxCommitProbe,
    handleSqlTxRollbackProbe,
    handleSqlOneMultiProbe,
    handleConnectionsSnapshotProbe,
  ],
});

export type CtxSqlClient = InferClient<typeof ctxSqlDefinition>;
