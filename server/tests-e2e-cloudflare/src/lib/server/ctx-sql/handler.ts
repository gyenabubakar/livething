import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const SaveNote = event('save-note', v.object({ title: v.string(), body: v.string() }));
const GetNotes = event('get-notes', v.object({}));
const NotesList = event(
  'notes-list',
  v.object({
    notes: v.array(v.object({ id: v.number(), title: v.string(), body: v.string() })),
  }),
);

const SqlOneProbe = event('sql-one-probe', v.object({}));
const SqlOneResult = event(
  'sql-one-result',
  v.object({ row: v.nullable(v.object({ c: v.number() })) }),
);

const SqlOneEmptyProbe = event('sql-one-empty-probe', v.object({}));
const SqlOneEmptyResult = event(
  'sql-one-empty-result',
  v.object({ row: v.nullable(v.object({ c: v.number() })) }),
);

const SqlRawProbe = event('sql-raw-probe', v.object({}));
const SqlRawResult = event('sql-raw-result', v.object({ rows: v.array(v.array(v.unknown())) }));

function selectNotes(ctx: {
  sql: { exec: (sql: string, ...params: unknown[]) => { toArray: () => unknown[] } };
}) {
  return ctx.sql.exec('SELECT id, title, body FROM notes ORDER BY id DESC').toArray() as {
    id: number;
    title: string;
    body: string;
  }[];
}

export const ctxSqlHandler = withLifecycle(server<Env>('ctx-sql'))
  .outgoing(NotesList)
  .outgoing(SqlOneResult)
  .outgoing(SqlOneEmptyResult)
  .outgoing(SqlRawResult)
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
  .incoming(SaveNote, (ctx, payload) => {
    ctx.sql.exec('INSERT INTO notes (title, body) VALUES (?, ?)', payload.title, payload.body);
    ctx.send('notes-list', { notes: selectNotes(ctx) });
  })
  .incoming(GetNotes, (ctx) => {
    ctx.send('notes-list', { notes: selectNotes(ctx) });
  })
  .incoming(SqlOneProbe, (ctx) => {
    const row = ctx.sql.exec('SELECT COUNT(*) AS c FROM notes').one() as { c: number } | null;
    ctx.send('sql-one-result', { row: row ? { c: Number(row.c) } : null });
  })
  .incoming(SqlRawProbe, (ctx) => {
    const rows = ctx.sql.exec('SELECT id, title FROM notes ORDER BY id DESC').raw();
    ctx.send('sql-raw-result', { rows: rows as unknown[][] });
  })
  .incoming(SqlOneEmptyProbe, (ctx) => {
    const row = ctx.sql.exec('SELECT COUNT(*) AS c FROM notes WHERE id = -999').one() as {
      c: number;
    } | null;
    ctx.send('sql-one-empty-result', { row: row ? { c: Number(row.c) } : null });
  })
  .build();
