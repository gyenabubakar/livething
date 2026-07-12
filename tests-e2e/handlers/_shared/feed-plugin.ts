import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { plugin } from '@wskit/server/plugin';
import { requests } from '@wskit/server/requests';
import { recordedStream, resumableStream, stream } from '@wskit/server/streams';
import * as v from 'valibot';

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
    emits({ welcome: t<{ name: string }>() }),
  ],
});

// Client → plugin-owned channel: subscribing broadcasts a `joined` event back.
const room = h.channel('room', {
  outgoing: { emits: { joined: t<{ who: string }>() } },
});

room.subscribe((ctx) => {
  ctx.channel.broadcast('joined', { who: ctx.id }, { excludeSelf: false });
});

// Client → plugin-owned DYNAMIC channel family: subscribing to `thread:<id>`
// broadcasts a `posted` naming the concrete thread, so the client can prove it
// addressed a specific member — not one shared channel.
const thread = h.channel(['thread', 'thread:{id}'], {
  outgoing: { emits: { posted: t<{ thread: string }>() } },
});

thread.subscribe((ctx) => {
  ctx.channel.broadcast('posted', { thread: ctx.channel.name }, { excludeSelf: false });
});

// Client → plugin incoming event, plugin emits back.
const hello = h.on('hello', {
  input: v.object({ name: v.string() }),
  run(ctx, payload) {
    ctx.send('welcome', { name: payload.name });
  },
});

// Client → plugin request, plugin returns a response.
const echo = h.request('echo', {
  input: v.object({ text: v.string() }),
  run(_ctx, payload) {
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
  handler: h.assemble(hello, echo, feed, feedPlain, feedRecorded, room, thread),
});
