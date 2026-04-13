import { base } from '../setup.ts';
import { GetNotes, KvGet, KvSet, SaveNote } from './events.ts';

export const storageHandlers = base.group((g) =>
  g
    .incoming(SaveNote, (ctx, payload) => {
      ctx.sql.exec(
        'INSERT INTO notes (title, body, author) VALUES (?, ?, ?)',
        payload.title,
        payload.body,
        ctx.meta.username,
      );
      ctx.send('notes-list', {
        notes: ctx.sql.exec('SELECT id, title, body FROM notes ORDER BY id DESC').toArray() as {
          id: number;
          title: string;
          body: string;
        }[],
      });
    })
    .incoming(GetNotes, (ctx) => {
      const notes = ctx.sql
        .exec('SELECT id, title, body FROM notes ORDER BY id DESC')
        .toArray() as {
        id: number;
        title: string;
        body: string;
      }[];
      ctx.send('notes-list', { notes });
    })
    .incoming(KvSet, async (ctx, payload) => {
      await ctx.kv.set(payload.key, payload.value);
      ctx.send('kv-result', { key: payload.key, value: payload.value });
    })
    .incoming(KvGet, async (ctx, payload) => {
      const value = await ctx.kv.get(payload.key);
      ctx.send('kv-result', { key: payload.key, value: value ?? null });
    }),
);
