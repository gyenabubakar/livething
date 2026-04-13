import { server } from '@wskit/server';
import type { InferClient } from '@wskit/server';

import '@wskit/server/dedup';
import '@wskit/server/lifecycle';
import '@wskit/server/replay/custom';
import '@wskit/server/sequence';

import { RejectUpgrade } from '@wskit/server/errors/symbols';
import { AddNote, Note } from './events.ts';

let sqlRef: { exec: (query: string, ...params: unknown[]) => unknown } | null = null;

export const replayCustomHandler = server<Env>('replay-custom-test')
  .sequence({ persist: true })
  .dedup()
  .outgoing(Note)
  .replayCustom((r) =>
    r
      .onBeforeSend((msg) => {
        if (sqlRef) {
          sqlRef.exec(
            'INSERT INTO _custom_replay (event, payload, seq, message_id) VALUES (?, ?, ?, ?)',
            msg.event,
            JSON.stringify(msg.payload),
            msg.wire.seq,
            msg.wire.messageId,
          );
        }
      })
      .onReplay(async (ctx, since) => {
        const rows = ctx.sql
          .exec(
            'SELECT event, payload, seq, message_id FROM _custom_replay WHERE seq > ? ORDER BY seq ASC',
            since,
          )
          .toArray() as { event: string; payload: string; seq: number; message_id: string }[];

        for (const row of rows) {
          ctx.sendReplay(row.event, JSON.parse(row.payload), {
            seq: row.seq,
            messageId: row.message_id,
          });
        }
      }),
  )
  .onInit((ctx) => {
    sqlRef = ctx.sql;
    ctx.sql.exec(`
      CREATE TABLE IF NOT EXISTS _custom_replay (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT NOT NULL
      )
    `);
  })
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { meta: { username } };
  })
  .incoming(AddNote, (ctx, payload) => {
    ctx.send('note', { text: payload.text, author: ctx.meta.username });
    ctx.broadcast('note', { text: payload.text, author: ctx.meta.username });
  })
  .build();

export type ReplayCustomClient = InferClient<typeof replayCustomHandler>;
