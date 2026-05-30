import { contract, implement, incoming, outgoing, t } from '@wskit/server';
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

export const ctxSqlContract = contract('ctx-sql', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    incoming('save-note', v.object({ title: v.string(), body: v.string() })),
    incoming('get-notes', v.object({})),
    incoming('sql-one-probe', v.object({})),
    incoming('sql-one-empty-probe', v.object({})),
    incoming('sql-raw-probe', v.object({})),
    incoming('sql-reuse-probe', v.object({})),
    incoming('sql-tx-commit-probe', v.object({})),
    incoming('sql-tx-rollback-probe', v.object({})),
    incoming('sql-one-multi-probe', v.object({})),
    incoming('connections-snapshot-probe', v.object({})),
    incoming('read-env-probe', v.object({})),

    outgoing(
      'notes-list',
      v.object({
        notes: v.array(v.object({ id: v.number(), title: v.string(), body: v.string() })),
      }),
    ),
    outgoing('sql-one-result', v.object({ row: v.nullable(v.object({ c: v.number() })) })),
    outgoing('sql-one-empty-result', v.object({ row: v.nullable(v.object({ c: v.number() })) })),
    outgoing('sql-raw-result', v.object({ rows: v.array(v.array(v.unknown())) })),
    outgoing('sql-reuse-result', v.object({ error: v.string() })),
    outgoing('snapshot-result', v.object({ count: v.number(), shapeOk: v.boolean() })),
    outgoing('env-result', v.object({ keyCount: v.number() })),
  ],
});

export const ctxSqlHandler = implement(ctxSqlContract)
  .onInit((ctx) => {
    ctx.sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL
      )
    `);
  })
  .onUpgrade((request) => requireUsername(request))
  .on('save-note', (ctx, payload) => {
    ctx.sql.exec('INSERT INTO notes (title, body) VALUES (?, ?)', payload.title, payload.body);
    ctx.send('notes-list', { notes: selectNotes(ctx) });
  })
  .on('get-notes', (ctx) => {
    ctx.send('notes-list', { notes: selectNotes(ctx) });
  })
  .on('sql-one-probe', (ctx) => {
    const row = ctx.sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM notes').one();
    ctx.send('sql-one-result', { row: row ? { c: Number(row.c) } : null });
  })
  .on('sql-raw-probe', (ctx) => {
    const rows = ctx.sql.exec('SELECT id, title FROM notes ORDER BY id DESC').raw();
    ctx.send('sql-raw-result', { rows: rows as unknown[][] });
  })
  .on('sql-reuse-probe', (ctx) => {
    const result = ctx.sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM notes');
    result.one();
    let error = '';
    try {
      result.toArray();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    ctx.send('sql-reuse-result', { error });
  })
  .on('sql-one-empty-probe', (ctx) => {
    const row = ctx.sql.exec<{ c: number }>('SELECT id AS c FROM notes WHERE id = -999').one();
    ctx.send('sql-one-empty-result', { row: row ? { c: Number(row.c) } : null });
  })
  .on('sql-tx-commit-probe', (ctx) => {
    ctx.sql.transaction((tx) => {
      tx.exec('INSERT INTO notes (title, body) VALUES (?, ?)', 'tx-a', 'a');
      tx.exec('INSERT INTO notes (title, body) VALUES (?, ?)', 'tx-b', 'b');
    });
    ctx.send('notes-list', { notes: selectNotes(ctx) });
  })
  .on('sql-tx-rollback-probe', (ctx) => {
    try {
      ctx.sql.transaction((tx) => {
        tx.exec('INSERT INTO notes (title, body) VALUES (?, ?)', 'tx-rollback', 'x');
        throw new Error('roll it back');
      });
    } catch {
      // expected — the transaction rethrows after rolling back.
    }
    ctx.send('notes-list', { notes: selectNotes(ctx) });
  })
  .on('sql-one-multi-probe', (ctx) => {
    ctx.sql.exec('INSERT INTO notes (title, body) VALUES (?, ?)', 'm1', 'x');
    ctx.sql.exec('INSERT INTO notes (title, body) VALUES (?, ?)', 'm2', 'x');
    let error = '';
    try {
      ctx.sql.exec('SELECT id FROM notes').one();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    ctx.send('sql-reuse-result', { error });
  })
  .on('connections-snapshot-probe', (ctx) => {
    const conns = ctx.getConnections();
    const c = conns[0];
    const shapeOk =
      !!c &&
      typeof c.id === 'string' &&
      c.id.length > 0 &&
      typeof c.identity === 'string' &&
      typeof c.meta === 'object' &&
      Array.isArray(c.channels) &&
      Array.isArray(c.tags) &&
      (c.latency === null || typeof c.latency === 'number') &&
      (c.quality === null || typeof c.quality === 'string') &&
      typeof c.bufferedAmount === 'number';
    ctx.send('snapshot-result', { count: conns.length, shapeOk });
  })
  .on('read-env-probe', (ctx) => {
    ctx.send('env-result', { keyCount: Object.keys(ctx.env as object).length });
  })
  .build();

export type CtxSqlClient = InferClient<typeof ctxSqlHandler>;
