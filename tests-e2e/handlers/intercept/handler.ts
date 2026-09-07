import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { clientRequests } from '@wskit/server/client-requests';
import { Block } from '@wskit/server/errors';
import { intercepts } from '@wskit/server/intercepts';
import { stream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = define({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({ echoed: t<{ text: string }>() }),
    // Top-level client→server request — used to verify the intercept pipeline
    // runs for frame.kind === 'request' and can rewrite the payload before the
    // request handler (and validator) see it.
    clientRequests(),
    stream(),
    channels(),
    intercepts(),
  ],
});

// Top-level intercept. The v2 ctx has no payload-narrowing helper yet (see file
// note), so we gate on frame.event/frame.kind and cast the raw payload.
base.intercept((_ctx, frame) => {
  if (frame.kind === 'incoming' && frame.event === 'echo') {
    const p = frame.payload as { text: string };
    if (p.text === 'top-pre') return { text: 'top-pre-rewritten' };

    if (p.text === 'top-passthrough') return;
  }

  // Request frames arrive with kind === 'request'. The handler echoes the
  // rewritten value so the test can prove the intercept ran.
  if (frame.kind === 'request' && frame.event === 'intercept-req') {
    const p = frame.payload as { text: string };
    if (p.text === 'req-pre') return { text: 'req-pre-rewritten' };
  }

  // Nudge frames arrive with kind === 'nudge'. Transform the hint payload so
  // the generator can prove the intercept ran before nudges were buffered.
  if (frame.kind === 'nudge' && frame.event === 'hint') {
    const p = frame.payload as { text: string };
    if (p.text === 'hint-block') throw Block;

    return { text: `${p.text}-intercepted` };
  }
});

const handleNudgeStream = base.stream('nudge-stream', {
  input: v.object({}),
  chunk: t<{ saw: string }>(),
  nudges: { hint: v.object({ text: v.string() }) },
  async *run(ctx) {
    // Yield 'started' first so the page knows the stream is live and can send
    // a nudge. Then poll in a short loop so the nudge has time to travel from
    // client to server before the generator drains nudges. Give up after 10
    // iterations so the Block test (where no hint ever arrives) can settle.
    let nudges = ctx.stream.nudges(yield { saw: 'started' });
    let loops = 0;
    while (!nudges.some((n) => n.event === 'hint') && loops < 10) {
      loops++;
      await new Promise((r) => setTimeout(r, 50));
      nudges = ctx.stream.nudges(yield { saw: 'waiting' });
    }

    const hint = nudges.find((n) => n.event === 'hint');
    yield { saw: hint ? (hint.payload as { text: string }).text : 'no-hint' };
  },
});

const handleEcho = base.on('echo', {
  input: v.object({ text: v.string() }),
  run(ctx, payload) {
    ctx.send('echoed', { text: `top:${payload.text}` });
  },
});

const handleInterceptReq = base.request('intercept-req', {
  input: v.object({ text: v.string() }),
  run(_ctx, payload) {
    // The response reflects whatever payload the intercept left behind, so the
    // test can prove the intercept ran by reading the request reply.
    return { text: payload.text };
  },
});

const room = base.channel('room', {
  capabilities: [emits({ echoed: t<{ text: string }>() })],
});

room.intercept((_ctx, frame) => {
  if (frame.kind === 'incoming' && frame.event === 'echo') {
    const p = frame.payload as { text: string };
    if (p.text === 'ch-pre') return { text: 'ch-pre-rewritten' };

    if (p.text === 'ch-pre-block') throw Block;
  }

  if (frame.kind === 'nudge' && frame.event === 'ch-hint') {
    const p = frame.payload as { text: string };
    if (p.text === 'ch-hint-block') throw Block;

    return { text: `${p.text}-ch-intercepted` };
  }
});

const handleRoomEcho = room.on('echo', {
  input: v.object({ text: v.string() }),
  run(ctx, payload) {
    ctx.channel.send('echoed', { text: `ch:${payload.text}` });
  },
});

const handleChNudgeStream = room.stream('ch-nudge-stream', {
  input: v.object({}),
  chunk: t<{ saw: string }>(),
  nudges: { 'ch-hint': v.object({ text: v.string() }) },
  async *run(ctx) {
    let nudges = ctx.stream.nudges(yield { saw: 'started' });
    let loops = 0;
    while (!nudges.some((n) => n.event === 'ch-hint') && loops < 10) {
      loops++;
      await new Promise((r) => setTimeout(r, 50));
      nudges = ctx.stream.nudges(yield { saw: 'waiting' });
    }

    const hint = nudges.find((n) => n.event === 'ch-hint');
    yield { saw: hint ? (hint.payload as { text: string }).text : 'no-hint' };
  },
});

const rooms = base.channel(['rooms', 'room:{id}'], {
  capabilities: [emits({ echoed: t<{ text: string }>() })],
});

rooms.intercept((_ctx, frame) => {
  if (frame.kind === 'incoming' && frame.event === 'echo') {
    const p = frame.payload as { text: string };
    if (p.text === 'dyn-pre') return { text: 'dyn-pre-rewritten' };

    if (p.text === 'dyn-pre-block') throw Block;
  }
});

const handleRoomsEcho = rooms.on('echo', {
  input: v.object({ text: v.string() }),
  run(ctx, payload) {
    ctx.channel.send('echoed', { text: `dyn:${payload.text}` });
  },
});

export const interceptHandler = base.assemble({
  handlers: [
    handleEcho,
    handleInterceptReq,
    handleNudgeStream,
    handleRoomEcho,
    handleChNudgeStream,
    handleRoomsEcho,
  ],
});

export type InterceptClient = InferClient<typeof interceptHandler>;
