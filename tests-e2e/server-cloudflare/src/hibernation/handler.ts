import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { stream } from '@wskit/server/streams';
import { tags } from '@wskit/server/tags';
import { requireUsernameWithUserTag } from '@wskit/tests-e2e-handlers/_shared/upgrade';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';

const BroadcastToRoomPayload = v.object({ text: v.string() });
const SaveNotePayload = v.object({ title: v.string(), body: v.string() });
const GetNotesPayload = v.object({});
const TagSelfPayload = v.object({ tag: v.string() });
const SendToTagPayload = v.object({ tag: v.string(), text: v.string() });
const GetRoomMembersPayload = v.object({});
const ProbeConnPayload = v.object({});

const StartSlowStreamPayload = v.object({});
const SlowChunk = v.object({ index: v.number() });

const base = define({
  env: t<Env>(),
  hibernation: { enabled: true },
  upgrade: (request) => requireUsernameWithUserTag(request),
  capabilities: [
    channels(),
    stream(),
    tags((ephemeral) => [ephemeral('user', t<string>()), ephemeral('label', t<string>())]),
    emits({
      'notes-list': t<{ notes: Array<{ title: string; body: string }> }>(),
      'conn-info': t<{
        quality: 'excellent' | 'good' | 'degraded' | 'poor' | null;
        latency: number | null;
      }>(),
      'tag-result': t<{ tags: string[] }>(),
      'tagged-message': t<{ text: string; from: string }>(),
      'room-members-count': t<{ count: number }>(),
    }),
  ],
});

base.init((ctx) => {
  ctx.sql.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

const handleSaveNote = base.on('save-note', {
  input: SaveNotePayload,
  run(ctx, payload) {
    ctx.sql.exec('INSERT INTO notes (title, body) VALUES (?, ?)', payload.title, payload.body);
    ctx.send('notes-list', {
      notes: ctx.sql
        .exec<{ title: string; body: string }>('SELECT title, body FROM notes')
        .toArray(),
    });
  },
});

const handleGetNotes = base.on('get-notes', {
  input: GetNotesPayload,
  run(ctx) {
    ctx.send('notes-list', {
      notes: ctx.sql
        .exec<{ title: string; body: string }>('SELECT title, body FROM notes')
        .toArray(),
    });
  },
});

const handleTagSelf = base.on('tag-self', {
  input: TagSelfPayload,
  run(ctx, payload) {
    ctx.tags.ephemeral('label').add(payload.tag);
    ctx.send('tag-result', {
      tags: ctx.tags
        .list()
        .map(
          (entry: { group: string; key: string; kind: string }) => `${entry.group}:${entry.key}`,
        ),
    });
  },
});

const handleSendToTag = base.on('send-to-tag', {
  input: SendToTagPayload,
  run(ctx, payload) {
    ctx.tags.ephemeral('label').ref(payload.tag).send('tagged-message', {
      text: payload.text,
      from: ctx.meta.username,
    });
  },
});

const handleGetRoomMembers = base.on('get-room-members', {
  input: GetRoomMembersPayload,
  run(ctx) {
    ctx.send('room-members-count', { count: ctx.channels.get('room').members().length });
  },
});

const handleProbeConn = base.on('probe-conn', {
  input: ProbeConnPayload,
  run(ctx) {
    // No keepalive in hibernation mode (a connection timer would keep waking the
    // DO), so there is never a latency measurement — quality and latency are null.
    ctx.send('conn-info', { quality: null, latency: null });
  },
});

const handleSlowStream = base.stream('start-slow-stream', {
  input: StartSlowStreamPayload,
  chunk: SlowChunk,
  async *run() {
    for (let i = 0; i < 10; i++) {
      yield { index: i };
      await new Promise((r) => setTimeout(r, 2_000));
    }
  },
});

const room = base.channel('room', {
  outgoing: { emits: { 'room-message': t<{ text: string }>() } },
});

const handleBroadcastToRoom = room.on('broadcast-to-room', {
  input: BroadcastToRoomPayload,
  run(ctx, payload) {
    ctx.channel.broadcast('room-message', { text: payload.text });
  },
});

export const hibernationHandler = base.assemble(
  handleSaveNote,
  handleGetNotes,
  handleTagSelf,
  handleSendToTag,
  handleGetRoomMembers,
  handleProbeConn,
  handleSlowStream,
  handleBroadcastToRoom,
);

export type HibernationClient = InferClient<typeof hibernationHandler>;
