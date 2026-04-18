import { base } from '../setup.ts';
import {
  GetNotes,
  KvDelete,
  KvGet,
  KvSet,
  KvSetTtl,
  SaveNote,
  SqlOneProbe,
  SqlRawProbe,
} from './events.ts';

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
    })
    .incoming(KvSetTtl, async (ctx, payload) => {
      await ctx.kv.set(payload.key, payload.value, { ttl: payload.ttlMs });
      ctx.send('kv-result', { key: payload.key, value: payload.value });
    })
    .incoming(KvDelete, async (ctx, payload) => {
      await ctx.kv.delete(payload.key);
      ctx.send('kv-result', { key: payload.key, value: null });
    })
    .incoming(SqlOneProbe, (ctx) => {
      const row = ctx.sql.exec('SELECT COUNT(*) AS c FROM notes').one() as { c: number } | null;
      ctx.send('sql-one-result', { row: row ? { c: Number(row.c) } : null });
    })
    .incoming(SqlRawProbe, (ctx) => {
      const rows = ctx.sql.exec('SELECT id, title FROM notes ORDER BY id DESC').raw();
      ctx.send('sql-raw-result', { rows });
    }),
);
