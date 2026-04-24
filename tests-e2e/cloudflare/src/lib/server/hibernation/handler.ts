import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withHibernation } from '@wskit/server/hibernation';
import { withInfrastructure } from '@wskit/server/infrastructure';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const BroadcastToRoom = event('broadcast-to-room', v.object({ text: v.string() }));
const RoomMessage = event('room-message', v.object({ text: v.string() }));
const SaveNote = event('save-note', v.object({ title: v.string(), body: v.string() }));
const GetNotes = event('get-notes', v.object({}));
const NotesList = event(
  'notes-list',
  v.object({ notes: v.array(v.object({ title: v.string(), body: v.string() })) }),
);
const TagSelf = event('tag-self', v.object({ tag: v.string() }));
const TagResult = event('tag-result', v.object({ tags: v.array(v.string()) }));
const SendToTag = event('send-to-tag', v.object({ tag: v.string(), text: v.string() }));
const TaggedMessage = event('tagged-message', v.object({ text: v.string(), from: v.string() }));

const StartSlowStream = event('start-slow-stream', v.object({}));
const SlowChunk = v.object({ index: v.number() });

const GetRoomMembers = event('get-room-members', v.object({}));
const RoomMembersCount = event('room-members-count', v.object({ count: v.number() }));

const base = withStreams(
  withChannels(withHibernation(withInfrastructure(withLifecycle(server<Env>('hibernation'))))),
)
  .hibernation()
  .outgoing(NotesList)
  .outgoing(TagResult)
  .outgoing(TaggedMessage)
  .outgoing(RoomMembersCount)
  .onUpgrade((request) => requireUsername(request))
  .onInit((ctx) => {
    ctx.sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

const roomChannel = base.channel('room', (c) =>
  c.outgoing(RoomMessage).incoming(BroadcastToRoom, (ctx, payload) => {
    ctx.channel.broadcast('room-message', { text: payload.text });
  }),
);

export const hibernationHandler = base
  .stream(StartSlowStream, (s) =>
    s.chunk(SlowChunk).generate(async function* () {
      for (let i = 0; i < 10; i++) {
        yield { index: i };
        // Long gap so the DO can hibernate between yields.
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }),
  )
  .use(roomChannel)
  .incoming(SaveNote, (ctx, payload) => {
    ctx.sql.exec('INSERT INTO notes (title, body) VALUES (?, ?)', payload.title, payload.body);
    ctx.send('notes-list', {
      notes: ctx.sql
        .exec<{ title: string; body: string }>('SELECT title, body FROM notes')
        .toArray(),
    });
  })
  .incoming(GetNotes, (ctx) => {
    ctx.send('notes-list', {
      notes: ctx.sql
        .exec<{ title: string; body: string }>('SELECT title, body FROM notes')
        .toArray(),
    });
  })
  .incoming(TagSelf, (ctx, payload) => {
    ctx.tag(payload.tag);
    // ctx.tag() doesn't mutate ctx.tags in place; compose the new set.
    const next = Array.from(new Set([...ctx.tags, payload.tag]));
    ctx.send('tag-result', { tags: next });
  })
  .incoming(SendToTag, (ctx, payload) => {
    ctx.sendTo(payload.tag, 'tagged-message', {
      text: payload.text,
      from: ctx.meta.username,
    });
  })
  .incoming(GetRoomMembers, (ctx) => {
    ctx.send('room-members-count', { count: ctx.channels.members('room').length });
  })
  .build();
