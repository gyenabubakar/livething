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
  .build();

export type CtxSqlClient = InferClient<typeof ctxSqlHandler>;
