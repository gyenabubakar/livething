import { channel, contract, implement, incoming, outgoing, stream, t } from '@wskit/server';
import { requireUsername } from '@wskit/tests-e2e-handlers/_shared/upgrade';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';

const BroadcastToRoomPayload = v.object({ text: v.string() });
const RoomMessagePayload = v.object({ text: v.string() });
const SaveNotePayload = v.object({ title: v.string(), body: v.string() });
const GetNotesPayload = v.object({});
const NotesListPayload = v.object({
  notes: v.array(v.object({ title: v.string(), body: v.string() })),
});
const TagSelfPayload = v.object({ tag: v.string() });
const TagResultPayload = v.object({ tags: v.array(v.string()) });
const SendToTagPayload = v.object({ tag: v.string(), text: v.string() });
const TaggedMessagePayload = v.object({ text: v.string(), from: v.string() });

const StartSlowStreamPayload = v.object({});
const SlowChunk = v.object({ index: v.number() });

const GetRoomMembersPayload = v.object({});
const RoomMembersCountPayload = v.object({ count: v.number() });

const ProbeConnPayload = v.object({});
const ConnInfoPayload = v.object({
  quality: v.nullable(v.picklist(['excellent', 'good', 'degraded', 'poor'])),
  latency: v.nullable(v.number()),
});

export const hibernationContract = contract('hibernation', {
  env: t<Env>(),
  hibernation: true,
  meta: t<{ username: string }>(),
  tags: (ephemeral) => [ephemeral('user', t<string>()), ephemeral('label', t<string>())],
  definitions: [
    incoming('save-note', SaveNotePayload),
    incoming('get-notes', GetNotesPayload),
    incoming('tag-self', TagSelfPayload),
    incoming('send-to-tag', SendToTagPayload),
    incoming('get-room-members', GetRoomMembersPayload),
    incoming('probe-conn', ProbeConnPayload),

    outgoing('notes-list', NotesListPayload),
    outgoing('conn-info', ConnInfoPayload),
    outgoing('tag-result', TagResultPayload),
    outgoing('tagged-message', TaggedMessagePayload),
    outgoing('room-members-count', RoomMembersCountPayload),

    stream('start-slow-stream', { payload: StartSlowStreamPayload, chunk: SlowChunk }),

    channel('room', {
      definitions: [
        outgoing('room-message', RoomMessagePayload),
        incoming('broadcast-to-room', BroadcastToRoomPayload),
      ],
    }),
  ],
});

export const hibernationHandler = implement(hibernationContract)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))
  .onInit((ctx) => {
    ctx.sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  })

  .on('save-note', (ctx, payload) => {
    ctx.sql.exec('INSERT INTO notes (title, body) VALUES (?, ?)', payload.title, payload.body);
    ctx.send('notes-list', {
      notes: ctx.sql
        .exec<{ title: string; body: string }>('SELECT title, body FROM notes')
        .toArray(),
    });
  })
  .on('get-notes', (ctx) => {
    ctx.send('notes-list', {
      notes: ctx.sql
        .exec<{ title: string; body: string }>('SELECT title, body FROM notes')
        .toArray(),
    });
  })
  .on('tag-self', (ctx, payload) => {
    ctx.tags.ephemeral('label').add(payload.tag);
    ctx.send('tag-result', {
      tags: ctx.tags
        .list()
        .map((t: { group: string; key: string; kind: string }) => `${t.group}:${t.key}`),
    });
  })
  .on('send-to-tag', (ctx, payload) => {
    ctx.tags.ephemeral('label').ref(payload.tag).send('tagged-message', {
      text: payload.text,
      from: ctx.meta.username,
    });
  })
  .on('get-room-members', (ctx) => {
    ctx.send('room-members-count', { count: ctx.channels.get('room').members().length });
  })
  .on('probe-conn', (ctx) => {
    ctx.send('conn-info', { quality: ctx.quality, latency: ctx.latency });
  })

  .stream('start-slow-stream', async function* () {
    for (let i = 0; i < 10; i++) {
      yield { index: i };
      await new Promise((r) => setTimeout(r, 2_000));
    }
  })

  .channel('room', (ch) =>
    ch.on('broadcast-to-room', (ctx, payload) => {
      ctx.channel.broadcast('room-message', { text: payload.text });
    }),
  )

  .build();

export type HibernationClient = InferClient<typeof hibernationHandler>;
