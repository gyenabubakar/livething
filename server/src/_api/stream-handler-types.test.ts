import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import {
  channel,
  contract,
  implement,
  nudge,
  recordedStream,
  resumableStream,
  stream,
  t,
} from './index.ts';

const TextPayload = v.object({ text: v.string() });
const ChunkPayload = v.object({ ok: v.boolean() });
const CursorPayload = v.object({ idx: v.number() });
const HintPayload = v.object({ text: v.string() });

const c = contract('stream-handler-types', {
  env: t<Record<string, unknown>>(),
  persistence: true,
  definitions: [
    stream('top-stream', {
      payload: TextPayload,
      chunk: ChunkPayload,
      nudges: [nudge('top-hint', HintPayload)],
    }),
    resumableStream('top-resumable', {
      payload: TextPayload,
      chunk: ChunkPayload,
      cursor: CursorPayload,
      nudges: [nudge('top-resume-hint', HintPayload)],
    }),
    recordedStream('top-recorded', {
      payload: TextPayload,
      chunk: ChunkPayload,
      nudges: [nudge('top-record-hint', HintPayload)],
    }),
    channel('room', {
      definitions: [
        stream('ch-stream', {
          payload: TextPayload,
          chunk: ChunkPayload,
          nudges: [nudge('ch-hint', HintPayload)],
        }),
        resumableStream('ch-resumable', {
          payload: TextPayload,
          chunk: ChunkPayload,
          cursor: CursorPayload,
          nudges: [nudge('ch-resume-hint', HintPayload)],
        }),
        recordedStream('ch-recorded', {
          payload: TextPayload,
          chunk: ChunkPayload,
          nudges: [nudge('ch-record-hint', HintPayload)],
        }),
      ],
    }),
  ],
});

describe('stream handler types', () => {
  it('preserves top-level nudge payload types across stream kinds', () => {
    implement(c)
      .stream('top-stream', async function* (ctx, payload) {
        expectTypeOf(payload).toEqualTypeOf<{ text: string }>();
        expectTypeOf(ctx.nudges(undefined as unknown)).toEqualTypeOf<
          readonly { event: 'top-hint'; payload: { text: string } }[]
        >();
        yield { ok: true };
      })
      .resumableStream('top-resumable', async function* (ctx, payload) {
        expectTypeOf(payload).toEqualTypeOf<{ text: string }>();
        expectTypeOf(ctx.nudges(undefined as unknown)).toEqualTypeOf<
          readonly { event: 'top-resume-hint'; payload: { text: string } }[]
        >();
        yield { ok: true };
      })
      .recordedStream('top-recorded', async function* (ctx, payload) {
        expectTypeOf(payload).toEqualTypeOf<{ text: string }>();
        expectTypeOf(ctx.nudges(undefined as unknown)).toEqualTypeOf<
          readonly { event: 'top-record-hint'; payload: { text: string } }[]
        >();
        yield { ok: true };
      });
  });

  it('preserves channel nudge payload types across stream kinds', () => {
    implement(c).channel('room', (ch) =>
      ch
        .stream('ch-stream', async function* (ctx, payload) {
          expectTypeOf(payload).toEqualTypeOf<{ text: string }>();
          expectTypeOf(ctx.nudges(undefined as unknown)).toEqualTypeOf<
            readonly { event: 'ch-hint'; payload: { text: string } }[]
          >();
          yield { ok: true };
        })
        .resumableStream('ch-resumable', async function* (ctx, payload) {
          expectTypeOf(payload).toEqualTypeOf<{ text: string }>();
          expectTypeOf(ctx.nudges(undefined as unknown)).toEqualTypeOf<
            readonly { event: 'ch-resume-hint'; payload: { text: string } }[]
          >();
          yield { ok: true };
        })
        .recordedStream('ch-recorded', async function* (ctx, payload) {
          expectTypeOf(payload).toEqualTypeOf<{ text: string }>();
          expectTypeOf(ctx.nudges(undefined as unknown)).toEqualTypeOf<
            readonly { event: 'ch-record-hint'; payload: { text: string } }[]
          >();
          yield { ok: true };
        }),
    );
  });
});
