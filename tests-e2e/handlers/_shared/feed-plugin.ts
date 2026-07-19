import { define, emits, errors, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { error } from '@wskit/server/errors';
import { plugin } from '@wskit/server/plugin';
import { requests } from '@wskit/server/requests';
import { recordedStream, resumableStream, stream } from '@wskit/server/streams';
import * as v from 'valibot';

// A plugin-declared error. It leaves the server namespaced as `__e2e:feed::room-full`;
// the client plugin must hand it back to the app author as the plain `room-full`.
const RoomFull = error('room-full', v.object({ limit: v.number() }));

// A pure-wskit plugin (no DO adapter) that OWNS every client-facing wire
// surface a plugin can: an incoming handler, a client→server request, and all
// three stream kinds. Every one travels under the plugin's `__e2e:feed::`
// namespace, so this fixture exercises that the typed client can drive each
// direction without the `__` prefix being mistaken for a protocol frame.
//
// It lists no persistence and no dependsOn — the persistence the durable
// streams need is auto-derived from the streams the plugin owns, and the host
// must provide persistence().
const h = define({
  scoped: true,
  capabilities: [
    resumableStream(),
    recordedStream(),
    stream(),
    requests(),
    channels(),
    errors([RoomFull]),
    emits({ welcome: t<{ name: string }>() }),
  ],
});

// Client → plugin-owned channel: subscribing broadcasts a `joined` event back,
// and sending `chat` on the channel echoes a `said` back — this proves a client
// can SEND on a plugin channel (outgoing child events must be namespaced too, not
// just the incoming ones the server broadcasts).
const room = h.channel('room', {
  outgoing: { emits: { joined: t<{ who: string }>(), said: t<{ text: string }>() } },
  // A declared error thrown from a channel lifecycle handler leaves the server
  // namespaced (`__e2e:feed::room-full`); the client plugin must reject the
  // subscribe with the plain `room-full`.
  check(ctx) {
    if ((ctx.meta as { username?: string }).username === 'blocked') throw RoomFull({ limit: 5 });
  },
});

room.subscribe((ctx) => {
  ctx.channel.broadcast('joined', { who: ctx.connection.id }, { includeSelf: true });
});

const roomChat = room.on('chat', {
  input: v.object({ text: v.string() }),
  run(ctx, payload) {
    ctx.channel.broadcast('said', { text: payload.text }, { includeSelf: true });
  },
});

// Client → plugin-owned DYNAMIC channel family: subscribing to `thread:<id>`
// broadcasts a `posted` naming the concrete thread, so the client can prove it
// addressed a specific member — not one shared channel.
const thread = h.channel(['thread', 'thread:{id}'], {
  outgoing: { emits: { posted: t<{ thread: string }>() } },
});

thread.subscribe((ctx) => {
  ctx.channel.broadcast('posted', { thread: ctx.channel.name }, { includeSelf: true });
});

// Client → plugin incoming event, plugin emits back.
const hello = h.on('hello', {
  input: v.object({ name: v.string() }),
  run(ctx, payload) {
    ctx.send('welcome', { name: payload.name });
  },
});

// Client → plugin request, plugin returns a response — or throws its declared
// error on a magic input, to prove the request rejection reaches the client with
// the plain code, not the namespaced wire code.
const echo = h.request('echo', {
  input: v.object({ text: v.string() }),
  run(_ctx, payload) {
    if (payload.text === 'boom') throw RoomFull({ limit: 5 });
    return { echoed: payload.text };
  },
});

// Resumable (durable, cursor) stream.
const feed = h.resumableStream('feed', {
  input: v.object({ from: v.number() }),
  chunk: t<{ row: number }>(),
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx, payload) {
    const start = (ctx.stream.cursor as { row: number } | null)?.row ?? payload.from;
    for (let i = start + 1; i <= start + 5; i += 1) {
      yield ctx.stream.withCursor({ row: i }, { row: i });
      await new Promise((r) => setTimeout(r, 5));
    }
  },
});

// A slow plain stream with a declared nudge. The client sends `boost` mid-stream;
// the server registers the nudge under `__e2e:feed::boost`, so the nudge only
// validates if the client namespaced the nudge event like its trigger.
const nudgeable = h.stream('nudgeable', {
  input: v.object({}),
  chunk: t<{ n: number }>(),
  nudges: { boost: v.object({ amount: v.number() }) },
  async *run(ctx) {
    for (let i = 1; i <= 20; i += 1) {
      ctx.stream.nudges(yield { n: i });
      await new Promise((r) => setTimeout(r, 30));
    }
  },
});

// Plain (ephemeral) stream.
const feedPlain = h.stream('feed-plain', {
  input: v.object({}),
  chunk: t<{ n: number }>(),
  async *run() {
    for (let i = 1; i <= 3; i += 1) {
      yield { n: i };
      await new Promise((r) => setTimeout(r, 5));
    }
  },
});

// Recorded (durable, buffered/replayable) stream.
const feedRecorded = h.recordedStream('feed-recorded', {
  input: v.object({}),
  chunk: t<{ n: number }>(),
  maxChunks: 10,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run() {
    for (let i = 1; i <= 3; i += 1) {
      yield { n: i };
      await new Promise((r) => setTimeout(r, 5));
    }
  },
});

export const Feed = plugin('e2e:feed', {
  handler: h.assemble({
    handlers: [hello, echo, feed, nudgeable, feedPlain, feedRecorded, room, roomChat, thread],
  }),
});
