/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { encodeBinaryFrame, LiveThingConfigError, splitBinaryFrame } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { errors } from '~/errors/capability.ts';
import { error } from '~/errors/errors.ts';
import { StreamAborted } from '~/errors/index.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineRuntimeOptions, TransportFrame } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { SqlLimits } from '~/context.ts';

const general = { channel: { name: 'room:general', family: 'rooms' } };
const NO_BYTES = new Uint8Array(0);
const RecordingLost = error('recording-lost', v.object({ recordingId: v.string() }));

/** A piece of a file, `size` bytes long, whose values tell the pieces apart. */
function piece(size: number, mark: number): Uint8Array {
  return new Uint8Array(size).fill(mark);
}

interface Limits {
  maxChunks?: number;
  maxBufferBytes?: number;
}

interface BuildOptions {
  recording?: Limits;
  sqlLimits?: Partial<SqlLimits>;
  messageLimits?: EngineRuntimeOptions['messageLimits'];
  /** Sees every SQL statement the server runs. */
  onExec?: (query: string) => void;
}

function build(options: BuildOptions = {}) {
  const warnings: unknown[][] = [];
  /** What each generator saw: the bytes it started with, and the errors thrown into it. */
  const seen: unknown[] = [];
  /** The codes of the errors the app's `onError` hook saw. */
  const hookErrors: string[] = [];
  const base = server({
    capabilities: [binary(), channels(), recordedStream(), errors([RecordingLost])],
    onError(_ctx, error) {
      hookErrors.push((error as { code?: string }).code ?? String(error));
    },
  });
  const rooms = base.channel(['rooms', 'room:{roomId}'], {});
  const Input = v.object({
    recordingId: v.string(),
    pieces: v.number(),
    size: v.number(),
    /** How long to wait after each piece, so a client can continue while it runs. */
    gapMs: v.optional(v.number()),
    /** The piece at which the recording turns out to be lost. */
    lostAt: v.optional(v.number()),
  });
  const handleDownloadRecording = base.binary.recordedStream('download-recording', {
    input: Input,
    retentionAfterEndMs: 60_000,
    ...options.recording,
    async *run(_ctx, input, bytes) {
      seen.push({ started: [...bytes] });
      for (let mark = 1; mark <= input.pieces; mark += 1) {
        if (mark === input.lostAt) throw RecordingLost({ recordingId: input.recordingId });

        try {
          yield {
            info: mark === 1 ? { fileName: `${input.recordingId}.webm` } : null,
            bytes: piece(input.size, mark),
          };
        } catch (error) {
          seen.push((error as { detail?: unknown }).detail);
          throw error;
        }

        if (input.gapMs) await new Promise((resolve) => setTimeout(resolve, input.gapMs));
      }
    },
  });

  const handleDownloadRoomRecording = rooms.binary.recordedStream('download-room-recording', {
    input: Input,
    async *run(ctx, input) {
      for (let mark = 1; mark <= input.pieces; mark += 1) {
        yield { info: { room: ctx.channel.name }, bytes: piece(input.size, mark) };
      }
    },
  });
  // The creator's slides go to every member of the room.
  const handlePresentSlides = rooms.binary.recordedStream('present-slides', {
    input: Input,
    broadcast: true,
    async *run(_ctx, input) {
      for (let mark = 1; mark <= input.pieces; mark += 1) {
        yield { info: null, bytes: piece(input.size, mark) };
        if (input.gapMs) await new Promise((resolve) => setTimeout(resolve, input.gapMs));
      }
    },
  });
  const handleExportRoom = base.recordedStream('export-room', {
    input: v.object({ lines: v.number(), size: v.number() }),
    ...options.recording,
    async *run(_ctx, input) {
      for (let line = 1; line <= input.lines; line += 1) yield { text: 'x'.repeat(input.size) };
    },
  });
  const definition = base.assemble({
    handlers: [
      rooms,
      handleDownloadRecording,
      handleDownloadRoomRecording,
      handlePresentSlides,
      handleExportRoom,
    ],
  });

  let engine!: Engine;
  adapter({
    id: 'recorded-binary-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: {
          sql: createTestSql({
            ...(options.sqlLimits ? { limits: options.sqlLimits } : {}),
            ...(options.onExec ? { onExec: options.onExec } : {}),
          }),
          kv: createTestKV(),
        },
        timers: createTestTimers(),
        platform: {},
        logger: { info() {}, warn: (...args: unknown[]) => warnings.push(args), error() {} },
        ...(options.messageLimits ? { messageLimits: options.messageLimits } : {}),
      });
      return {};
    },
  })(definition, undefined as never);

  return { engine, warnings, seen, hookErrors };
}

/** What a socket reports as buffered. A socket made with it reports backpressure. */
interface Buffered {
  bytes: number;
}

async function connect(engine: Engine, userId = 'u_amara', buffered?: Buffered) {
  await engine.initialize();
  const sent: TransportFrame[] = [];
  const closes: (number | undefined)[] = [];
  const handle = engine.accept(Symbol(userId), {
    send: (data: TransportFrame) => {
      sent.push(data);
    },
    close: (code?: number) => closes.push(code),
    bufferedAmount: () => buffered?.bytes ?? 0,
    backpressureSupported: buffered !== undefined,
    userId,
  });
  await [...engine.core.connections.values()].at(-1)!.lifecycleReady;

  /** Every frame in order: text as JSON, binary as its envelope and bytes. */
  function frames(): { kind: 'text' | 'bytes'; envelope: any[]; bytes?: number[] }[] {
    return sent.map((data) => {
      if (data.kind === 'text') return { kind: 'text', envelope: JSON.parse(data.text) };

      const split = splitBinaryFrame(data.bytes);
      if (split.kind !== 'frame') throw new Error('the server sent a broken binary frame');

      return { kind: 'bytes', envelope: JSON.parse(split.envelope), bytes: [...split.bytes] };
    });
  }

  return {
    closes,
    frames,
    /** The frames of one stream, without `__streamOk__`. */
    streamFrames: (id: string) =>
      frames().filter(
        (frame) => frame.envelope[2]?.stream?.id === id && frame.envelope[0] !== '__streamOk__',
      ),
    /** Start a stream with one binary frame: its stream ID, its channel, and its bytes. */
    start: (
      event: string,
      info: unknown,
      frame: { id: string; metadata?: object; bytes?: Uint8Array },
    ) =>
      handle.handleBinaryMessage(
        encodeBinaryFrame(
          JSON.stringify([event, info, { ...frame.metadata, stream: { id: frame.id } }]),
          frame.bytes ?? NO_BYTES,
        ),
      ),
    send: (event: string, payload: unknown, metadata: unknown) =>
      handle.handleMessage(JSON.stringify([event, payload, metadata])),
    close: () => handle.handleClose(1006, 'dropped'),
  };
}

const standup = { recordingId: 'standup', pieces: 3, size: 4 };

describe('base.binary.recordedStream', () => {
  it('sends each chunk as one binary frame with its seq, and ends with the last seq', async () => {
    const { engine, seen } = build();
    const amara = await connect(engine);

    await amara.start('download-recording', standup, {
      id: 'rec-1',
      bytes: new Uint8Array([9, 9]),
    });

    const ok = amara.frames().find((frame) => frame.envelope[0] === '__streamOk__');
    expect(ok!.envelope[2]).toEqual({ stream: { id: 'rec-1', durability: 'persistent' } });
    expect(seen).toEqual([{ started: [9, 9] }]);
    expect(amara.streamFrames('rec-1')).toEqual([
      {
        kind: 'bytes',
        envelope: [
          'download-recording',
          { fileName: 'standup.webm' },
          { stream: { id: 'rec-1', durability: 'persistent', seq: 1 } },
        ],
        bytes: [1, 1, 1, 1],
      },
      {
        kind: 'bytes',
        envelope: [
          'download-recording',
          null,
          { stream: { id: 'rec-1', durability: 'persistent', seq: 2 } },
        ],
        bytes: [2, 2, 2, 2],
      },
      {
        kind: 'bytes',
        envelope: [
          'download-recording',
          null,
          { stream: { id: 'rec-1', durability: 'persistent', seq: 3 } },
        ],
        bytes: [3, 3, 3, 3],
      },
      { kind: 'text', envelope: ['__streamEnd__', null, { stream: { id: 'rec-1', seq: 3 } }] },
    ]);
  });

  it('sends the stored chunks after lastKnownSeq again as binary frames when the client continues', async () => {
    const { engine } = build();
    const amara = await connect(engine);
    await amara.start('download-recording', standup, { id: 'rec-1' });
    const live = amara.streamFrames('rec-1');
    await amara.close();

    const again = await connect(engine);
    await again.send('__continueStream__', { lastKnownSeq: 1 }, { stream: { id: 'rec-1' } });

    const resent = again.streamFrames('rec-1');
    expect(resent.slice(0, 2)).toEqual(live.slice(1, 3));
    expect(resent[2]!.envelope).toEqual([
      '__streamEnd__',
      null,
      { stream: { id: 'rec-1', seq: 3, event: 'download-recording' } },
    ]);
  });

  it('works in a channel, with the channel on each chunk and on the chunks sent again', async () => {
    const { engine } = build();
    const amara = await connect(engine);
    await amara.send('__subscribe__', {}, general);

    await amara.start(
      'download-room-recording',
      { ...standup, pieces: 2 },
      {
        id: 'rec-2',
        metadata: general,
      },
    );
    const live = amara.streamFrames('rec-2');
    expect(live.map((frame) => frame.kind)).toEqual(['bytes', 'bytes', 'text']);
    expect(live[0]!.envelope).toEqual([
      'download-room-recording',
      { room: 'room:general' },
      { ...general, stream: { id: 'rec-2', durability: 'persistent', seq: 1 } },
    ]);

    await amara.send(
      '__continueStream__',
      { lastKnownSeq: 0 },
      { ...general, stream: { id: 'rec-2' } },
    );
    const all = amara.streamFrames('rec-2');
    expect(all.slice(3, 5)).toEqual(live.slice(0, 2));
  });
});

/** The seq of each chunk, and `end <seq>` for the end, of one stream's frames. */
function seqsOf(frames: { envelope: any[] }[]): (number | string)[] {
  return frames.map((frame) => {
    if (frame.envelope[0] === '__streamEnd__') return `end ${frame.envelope[2].stream.seq}`;

    if (frame.envelope[0] === '__error__') return `error ${frame.envelope[1].detail?.reason}`;

    return frame.envelope[2].stream.seq;
  });
}

async function untilTrue(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (check()) return;

    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  throw new Error('condition never became true');
}

describe('continuing a recorded stream with many stored chunks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the stored chunks a page at a time', async () => {
    const pages: string[] = [];
    let watching = false;
    const { engine } = build({
      recording: { maxChunks: 2000 },
      onExec(query) {
        if (watching && /FROM __livething_stream_chunks/.test(query)) pages.push(query);
      },
    });
    const amara = await connect(engine);
    await amara.start('download-recording', { ...standup, pieces: 600 }, { id: 'rec-1' });

    watching = true;
    const again = await connect(engine);
    await again.send('__continueStream__', { lastKnownSeq: 0 }, { stream: { id: 'rec-1' } });
    watching = false;

    expect(seqsOf(again.streamFrames('rec-1'))).toEqual([
      ...Array.from({ length: 600 }, (_, i) => i + 1),
      'end 600',
    ]);
    expect(pages.filter((query) => /LIMIT/.test(query)).length).toBeGreaterThanOrEqual(3);
  });

  it('waits while the socket buffer is high, then sends the rest in order', async () => {
    const { engine } = build();
    const amara = await connect(engine);
    await amara.start('download-recording', { ...standup, pieces: 5 }, { id: 'rec-1' });

    const buffered = { bytes: 512 * 1024 };
    const again = await connect(engine, 'u_amara', buffered);
    const continued = again.send(
      '__continueStream__',
      { lastKnownSeq: 0 },
      { stream: { id: 'rec-1' } },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(again.streamFrames('rec-1')).toEqual([]);

    buffered.bytes = 0;
    await continued;
    expect(seqsOf(again.streamFrames('rec-1'))).toEqual([1, 2, 3, 4, 5, 'end 5']);
  });

  it('lets no live chunk overtake or repeat a stored one while the creator catches up', async () => {
    const { engine } = build();
    const amara = await connect(engine);
    void amara.start('download-recording', { ...standup, pieces: 12, gapMs: 5 }, { id: 'rec-1' });
    await untilTrue(() => amara.streamFrames('rec-1').length >= 3);
    await amara.close();

    const buffered = { bytes: 512 * 1024 };
    const again = await connect(engine, 'u_amara', buffered);
    void again.send('__continueStream__', { lastKnownSeq: 0 }, { stream: { id: 'rec-1' } });
    // The generator yields more chunks while the catch-up waits.
    await new Promise((resolve) => setTimeout(resolve, 40));
    buffered.bytes = 0;
    await untilTrue(() =>
      again.streamFrames('rec-1').some((frame) => frame.envelope[0] === '__streamEnd__'),
    );

    expect(seqsOf(again.streamFrames('rec-1'))).toEqual([
      ...Array.from({ length: 12 }, (_, i) => i + 1),
      'end 12',
    ]);
  });

  it('gives a subscriber that catches up the end after its stored chunks, with no repeat', async () => {
    const { engine } = build();
    const amara = await connect(engine);
    const kofi = await connect(engine, 'u_kofi');
    await amara.send('__subscribe__', {}, general);
    await kofi.send('__subscribe__', {}, general);

    void amara.start(
      'present-slides',
      { ...standup, pieces: 15, gapMs: 30 },
      { id: 'slides-1', metadata: general },
    );
    await untilTrue(() => kofi.streamFrames('slides-1').length >= 2);
    const seen = kofi.streamFrames('slides-1').length;
    await kofi.close();
    // A few slides are stored while Kofi is away.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const buffered = { bytes: 512 * 1024 };
    const again = await connect(engine, 'u_kofi', buffered);
    // The continue goes right after the subscribe, before the next slide.
    await again.send('__subscribe__', {}, general);
    void again.send(
      '__continueStream__',
      { lastKnownSeq: seen },
      { ...general, stream: { id: 'slides-1' } },
    );
    expect(engine.core.activeStreams.has('slides-1')).toBe(true);
    // The creator's generator ends while Kofi's catch-up waits.
    await untilTrue(() => !engine.core.activeStreams.has('slides-1'));
    expect(again.streamFrames('slides-1')).toEqual([]);
    buffered.bytes = 0;
    await untilTrue(() =>
      again.streamFrames('slides-1').some((frame) => frame.envelope[0] === '__streamEnd__'),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seqsOf(again.streamFrames('slides-1'))).toEqual([
      ...Array.from({ length: 15 - seen }, (_, i) => seen + i + 1),
      'end 15',
    ]);
  });

  it('runs the error hooks once, and gives the creator the declared error after its stored chunks', async () => {
    const { engine, hookErrors } = build();
    const amara = await connect(engine);
    void amara.start(
      'download-recording',
      { ...standup, pieces: 20, gapMs: 5, lostAt: 10 },
      { id: 'rec-1' },
    );
    await untilTrue(() => amara.streamFrames('rec-1').length >= 3);
    await amara.close();

    const buffered = { bytes: 512 * 1024 };
    const again = await connect(engine, 'u_amara', buffered);
    void again.send('__continueStream__', { lastKnownSeq: 0 }, { stream: { id: 'rec-1' } });
    // The generator throws while the catch-up waits.
    await untilTrue(() => !engine.core.activeStreams.has('rec-1'));
    expect(again.streamFrames('rec-1')).toEqual([]);
    buffered.bytes = 0;
    await untilTrue(() =>
      again.streamFrames('rec-1').some((frame) => frame.envelope[0] === '__error__'),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const frames = again.streamFrames('rec-1');
    expect(seqsOf(frames.slice(0, -1))).toEqual(Array.from({ length: 9 }, (_, i) => i + 1));
    expect(frames.at(-1)!.envelope).toEqual([
      '__error__',
      { code: 'recording-lost', detail: { recordingId: 'standup' } },
      { stream: { id: 'rec-1', terminated: true } },
    ]);
    expect(hookErrors).toEqual(['recording-lost']);
  });

  it('closes with 1013 a client whose buffer stays high for about 50 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const { engine } = build();
    const amara = await connect(engine);
    await amara.start('download-recording', standup, { id: 'rec-1' });

    const again = await connect(engine, 'u_amara', { bytes: 512 * 1024 });
    void again.send('__continueStream__', { lastKnownSeq: 0 }, { stream: { id: 'rec-1' } });
    await vi.advanceTimersByTimeAsync(49_000);
    expect(again.closes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_200);
    expect(again.closes).toEqual([1013]);
  });
});

describe('a recorded binary stream at a limit', () => {
  it('stops at maxChunks: the next chunk is not stored or sent, and the generator gets buffer-full', async () => {
    const { engine, seen } = build({ recording: { maxChunks: 2 } });
    const amara = await connect(engine);

    await amara.start('download-recording', standup, { id: 'rec-1' });

    const frames = amara.streamFrames('rec-1');
    expect(frames.filter((frame) => frame.kind === 'bytes')).toHaveLength(2);
    expect(seen.at(-1)).toEqual({ reason: 'buffer-full' });
    expect(frames.at(-1)!.envelope).toEqual([
      '__error__',
      { code: StreamAborted.code, detail: { reason: 'buffer-full' } },
      { stream: { id: 'rec-1', terminated: true } },
    ]);
  });

  it('stops before the chunk that would take the stored bytes over maxBufferBytes', async () => {
    // Each chunk is 100 bytes of the file, plus its info.
    const { engine, seen } = build({ recording: { maxBufferBytes: 250 } });
    const amara = await connect(engine);

    await amara.start('download-recording', { ...standup, size: 100 }, { id: 'rec-1' });

    const sent = amara.streamFrames('rec-1').filter((frame) => frame.kind === 'bytes');
    expect(sent.map((frame) => frame.envelope[2].stream.seq)).toEqual([1, 2]);
    expect(seen.at(-1)).toEqual({ reason: 'buffer-full' });
  });

  it('stops at a chunk over the storage row limit, sends nothing after the last stored chunk, and warns once', async () => {
    const { engine, seen, warnings } = build({ sqlLimits: { maxValueBytes: 2000 } });
    const amara = await connect(engine);

    await amara.start('download-recording', { ...standup, size: 3000 }, { id: 'rec-1' });
    await amara.start('download-recording', { ...standup, size: 3000 }, { id: 'rec-2' });

    expect(amara.streamFrames('rec-1').map((frame) => frame.envelope[0])).toEqual(['__error__']);
    expect(seen.filter((entry) => (entry as { reason?: string }).reason)).toEqual([
      { reason: 'buffer-full' },
      { reason: 'buffer-full' },
    ]);
    expect(warnings.map(([message]) => message)).toEqual([
      expect.stringMatching(/"download-recording".*over the storage row limit of 2000 bytes/),
    ]);
  });

  it('stops at a chunk over the send limit', async () => {
    const { engine, warnings } = build({
      messageLimits: { receiveBytes: 5000, sendBytes: 5000 },
    });
    const amara = await connect(engine);

    await amara.start('download-recording', { ...standup, pieces: 2, size: 6000 }, { id: 'rec-1' });

    expect(amara.streamFrames('rec-1').map((frame) => frame.envelope[1]?.detail)).toEqual([
      { reason: 'buffer-full' },
    ]);
    expect(warnings.map(([message]) => message)).toEqual([
      expect.stringMatching(/"download-recording".*over the send limit of 5000 bytes/),
    ]);
  });

  it('holds a JSON recorded stream to maxBufferBytes too', async () => {
    const { engine } = build({ recording: { maxBufferBytes: 250 } });
    const amara = await connect(engine);

    await amara.send('export-room', { lines: 3, size: 100 }, { stream: { id: 'exp-1' } });

    const frames = amara.streamFrames('exp-1');
    expect(frames.filter((frame) => frame.envelope[0] === 'export-room')).toHaveLength(2);
    expect(frames.at(-1)!.envelope[1]).toEqual({
      code: StreamAborted.code,
      detail: { reason: 'buffer-full' },
    });
  });
});

describe('binary.recordedStream config', () => {
  it('needs recordedStream(), and checks maxChunks and maxBufferBytes', () => {
    const noRecorded = server({ capabilities: [binary(), channels()] }) as any;
    expect(() =>
      noRecorded.binary.recordedStream('download-recording', { async *run() {} }),
    ).toThrow(/base\.binary\.recordedStream\(\) needs the recordedStream\(\) capability/);
    expect(() =>
      noRecorded.channel('lobby', {}).binary.recordedStream('download-lobby-recording', {
        async *run() {},
      }),
    ).toThrow(LiveThingConfigError);

    const base = server({ capabilities: [binary(), recordedStream()] }) as any;
    expect(() =>
      base.binary.recordedStream('download-recording', { maxChunks: 0, async *run() {} }),
    ).toThrow(/maxChunks/);
    expect(() =>
      base.binary.recordedStream('download-recording', { maxBufferBytes: 1.5, async *run() {} }),
    ).toThrow(/maxBufferBytes/);
  });
});
