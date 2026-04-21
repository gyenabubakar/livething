import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const InsertNote = event('insert-note', v.object({ body: v.string() }));
const ListNotes = event('list-notes', v.object({}));
const NotesList = event(
  'notes-list',
  v.object({ rows: v.array(v.object({ id: v.number(), body: v.string() })) }),
);

export const ctxSqlHandler = withLifecycle(server<Env>('ctx-sql'))
  .outgoing(NotesList)
  .onInit((ctx) => {
    ctx.sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        body TEXT NOT NULL
      )
    `);
  })
  .onUpgrade((request) => requireUsername(request))
  .incoming(InsertNote, (ctx, payload) => {
    ctx.sql.exec('INSERT INTO notes (body) VALUES (?)', payload.body);
  })
  .incoming(ListNotes, (ctx) => {
    const rows = ctx.sql.exec('SELECT id, body FROM notes').toArray() as {
      id: number;
      body: string;
    }[];
    ctx.send('notes-list', { rows });
  })
  .build();
