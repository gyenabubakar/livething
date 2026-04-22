import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withHibernation } from '@wskit/server/hibernation';
import { withInfrastructure } from '@wskit/server/infrastructure';
import { withLifecycle } from '@wskit/server/lifecycle';
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

const base = withChannels(
  withHibernation(withInfrastructure(withLifecycle(server<Env>('hibernation')))),
)
  .hibernation()
  .outgoing(NotesList)
  .outgoing(TagResult)
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
  .use(roomChannel)
  .incoming(SaveNote, (ctx, payload) => {
    ctx.sql.exec('INSERT INTO notes (title, body) VALUES (?, ?)', payload.title, payload.body);
    ctx.send('notes-list', {
      notes: ctx.sql.exec('SELECT title, body FROM notes').toArray() as {
        title: string;
        body: string;
      }[],
    });
  })
  .incoming(GetNotes, (ctx) => {
    ctx.send('notes-list', {
      notes: ctx.sql.exec('SELECT title, body FROM notes').toArray() as {
        title: string;
        body: string;
      }[],
    });
  })
  .incoming(TagSelf, (ctx, payload) => {
    ctx.tag(payload.tag);
    // ctx.tag() doesn't mutate ctx.tags in place; compose the new set.
    const next = Array.from(new Set([...ctx.tags, payload.tag]));
    ctx.send('tag-result', { tags: next });
  })
  .build();
