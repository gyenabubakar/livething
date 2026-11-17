/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { encodeBinaryFrame, LiveThingConfigError, splitBinaryFrame } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { isConnectedFrame } from '~/_test/connected.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { binary } from '~/binary/capability.ts';
import { errors } from '~/errors/capability.ts';
import { error as defineError } from '~/errors/errors.ts';
import { intercept } from '~/intercept/intercept.ts';
import { rateLimit } from '~/rate-limit/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { uploads } from '~/upload/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { EngineRuntimeOptions, TransportFrame } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { RateLimitGlobalConfig } from '~/rate-limit/capability.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';
import type { UploadsOptions } from '~/upload/capability.ts';

const NO_BYTES = new Uint8Array(0);

/** `size` bytes whose values tell the pieces apart. */
function piece(size: number, mark: number): Uint8Array {
  return new Uint8Array(size).fill(mark);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface BuildOptions {
  uploads?: UploadsOptions;
  /** Save after every piece (the default), or only when `run` ends. */
  saveEvery?: boolean;
  messageLimits?: EngineRuntimeOptions['messageLimits'];
  /** Throw from `run` after reading this many pieces. */
  throwAfter?: number;
  /** Make `onDiscard` throw this many times first. */
  discardFailures?: number;
  /** What `onDiscard` throws in those failures. Default: an `Error`. */
  discardError?: unknown;
  /** `run` waits for this before it reads each piece. */
  readGate?: Promise<void>;
  /** Runs with `ctx.upload` after each piece `run` reads; what it throws is recorded. */
  afterRead?: (upload: any) => void;
  /** What `run` returns instead of `{ info: { size } }`. */
  reply?: unknown;
  /** `run` catches what stops it (a drop, a takeover) and returns its reply anyway. */
  swallowStop?: boolean;
  /**
   * After its first piece, the first `run` waits for this and ignores its signal. Then it calls
   * `saved()` once more, and what that throws is recorded.
   */
  hang?: Promise<void>;
  /** The intercept holds each upload start this long, as an async check would. */
  slowStartMs?: number;
  /** How long the intercept holds each start frame, in the order they come. */
  startDelays?: number[];
  /** The server's global rate limit. Default: so high that no test reaches it. */
  rateLimit?: RateLimitGlobalConfig;
  /** The upload handler's own rate limit. */
  uploadRateLimit?: RateLimitConfig;
  /** Sees every SQL statement; a throw fails that statement. */
  onExec?: (query: string) => void;
  /** Share one database between engines, as a server that restarts does. */
  sql?: ReturnType<typeof createTestSql>;
  /** The handler's `state` schema. Default: `v.unknown()`. `null` declares none. */
  state?: v.GenericSchema | v.GenericSchemaAsync | null;
  logger?: {
    info(): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

function build(options: BuildOptions = {}) {
  /** What each run saw: where it started, the offsets of its pieces, and how it ended. */
  const runs: { savedThrough: number; state: unknown; offsets: number[]; ended?: string }[] = [];
  const discarded: { input: unknown; savedThrough: number; state: unknown }[] = [];
  const kinds: string[] = [];
  const hookErrors: string[] = [];
  const probeErrors: string[] = [];

  let discardFailures = options.discardFailures ?? 0;
  const base = server({
    capabilities: [
      binary(),
      uploads(options.uploads),
      rateLimit(options.rateLimit ?? { maxMessages: 1_000_000 }),
    ],
    onError(_ctx, error) {
      hookErrors.push((error as { code?: string }).code ?? String(error));
    },
  });
  const handleUploadAttachment = base.binary.upload('upload-attachment', {
    input: v.object({ attachmentId: v.string() }),
    maxBytes: 64,
    pieceBytes: 8,
    windowBytes: 16,
    state: (options.state === null ? undefined : (options.state ?? v.unknown())) as v.GenericSchema,
    ...(options.uploadRateLimit ? { rateLimit: options.uploadRateLimit } : {}),
    async run(ctx, _input, pieces) {
      const run = {
        savedThrough: ctx.upload.savedThrough,
        state: ctx.upload.state,
        offsets: [] as number[],
        ended: undefined as string | undefined,
      };

      runs.push(run);
      let size = ctx.upload.savedThrough;
      try {
        await Promise.race([
          options.readGate,
          new Promise((_resolve, reject) =>
            ctx.upload.signal.addEventListener('abort', () => reject(ctx.upload.signal.reason)),
          ),
        ]);
        for await (const { bytes, offset } of pieces) {
          run.offsets.push(offset);
          size = offset + bytes.byteLength;
          if (options.throwAfter !== undefined && run.offsets.length >= options.throwAfter) {
            throw new Error('the disk is full');
          }

          if (options.saveEvery !== false) {
            if (options.state === null) (ctx.upload.saved as (offset: number) => void)(size);
            else ctx.upload.saved(size, { state: { parts: run.offsets.length } });
          }

          try {
            options.afterRead?.(ctx.upload);
          } catch (error) {
            probeErrors.push((error as Error).message);
          }

          if (options.hang && run === runs[0]) {
            await options.hang;
            try {
              ctx.upload.saved(size, { state: { stale: true } });
            } catch (error) {
              probeErrors.push((error as { code?: string }).code ?? (error as Error).message);
            }
          }
        }
      } catch (error) {
        run.ended = (error as { code?: string }).code ?? (error as Error).message;
        if (!options.swallowStop) throw error;

        return (options.reply ?? { info: { size } }) as never;
      }

      run.ended = 'done';

      return (options.reply ?? { info: { size } }) as never;
    },
    onDiscard(ctx, input) {
      if (discardFailures > 0) {
        discardFailures -= 1;
        throw options.discardError ?? new Error('the storage is down');
      }

      discarded.push({ input, savedThrough: ctx.upload.savedThrough, state: ctx.upload.state });
    },
  });
  const watch = intercept(async (_ctx, frame) => {
    kinds.push(`${frame.event}:${frame.kind}`);
    const delay = options.startDelays?.shift() ?? options.slowStartMs;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

    return frame.payload;
  });
  const definition = base.assemble({ handlers: [handleUploadAttachment, watch as never] });

  let engine!: Engine;
  const timers = createTestTimers();
  const sql = options.sql ?? createTestSql(options.onExec ? { onExec: options.onExec } : {});
  adapter({
    id: 'upload-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql, kv: createTestKV() },
        timers,
        platform: {},
        logger: options.logger ?? { info() {}, warn() {}, error() {} },
        ...(options.messageLimits ? { messageLimits: options.messageLimits } : {}),
      });
      return {};
    },
  })(definition, undefined as never);

  return { engine, runs, discarded, kinds, hookErrors, probeErrors, timers, sql };
}

async function connect(engine: Engine, userId = 'u_amara') {
  await engine.initialize();
  const sent: TransportFrame[] = [];
  const handle = engine.accept(Symbol(userId), {
    send: (data: TransportFrame) => {
      if (!isConnectedFrame(data)) sent.push(data);
    },
    close: () => {},
    bufferedAmount: () => 0,
    backpressureSupported: false,
    userId,
  });
  await [...engine.core.connections.values()].at(-1)!.lifecycleReady;

  function frames(): any[][] {
    return sent.map((data) => {
      if (data.kind === 'text') return JSON.parse(data.text);

      const split = splitBinaryFrame(data.bytes);
      if (split.kind !== 'frame') throw new Error('the server sent a broken binary frame');

      return JSON.parse(split.envelope);
    });
  }

  return {
    frames,
    /** The frames of one upload, in order. */
    of: (id: string) => frames().filter((frame) => frame[2]?.upload?.id === id),
    start: (id: string, input: unknown, size?: number) =>
      handle.handleBinaryMessage(
        encodeBinaryFrame(
          JSON.stringify([
            'upload-attachment',
            input,
            { upload: { id, ...(size === undefined ? {} : { size }) } },
          ]),
          NO_BYTES,
        ),
      ),
    /** Send a piece, without waiting for `run` to read it. */
    piece: (id: string, seq: number, bytes: Uint8Array) => {
      void handle.handleBinaryMessage(
        encodeBinaryFrame(
          JSON.stringify(['upload-attachment', null, { upload: { id, seq } }]),
          bytes,
        ),
      );
    },
    end: (id: string, totalBytes: number) =>
      handle.handleMessage(JSON.stringify(['__uploadEnd__', { totalBytes }, { upload: { id } }])),
    cancel: (id: string) =>
      handle.handleMessage(JSON.stringify(['__uploadCancel__', null, { upload: { id } }])),
    /** Send any text frame. */
    sendText: (frame: unknown) => handle.handleMessage(JSON.stringify(frame)),
    /** Send piece 1 of `up-1` under another event name. */
    pieceAs: (event: string, bytes: Uint8Array) =>
      handle.handleBinaryMessage(
        encodeBinaryFrame(JSON.stringify([event, null, { upload: { id: 'up-1', seq: 1 } }]), bytes),
      ),
    /** Send a start frame for another upload event. */
    startAs: (event: string, id: string, input: unknown) =>
      handle.handleBinaryMessage(
        encodeBinaryFrame(JSON.stringify([event, input, { upload: { id } }]), NO_BYTES),
      ),
    /** Send any frame as a binary frame, with no bytes. */
    sendBinary: (frame: unknown) =>
      handle.handleBinaryMessage(encodeBinaryFrame(JSON.stringify(frame), NO_BYTES)),
    /** Send a start frame with any metadata. */
    startWith: (metadata: unknown) =>
      handle.handleBinaryMessage(
        encodeBinaryFrame(JSON.stringify(['upload-attachment', deck, metadata]), NO_BYTES),
      ),
    close: () => handle.handleClose(1006, 'dropped'),
    pendingBytes: () => [...engine.core.connections.values()].at(-1)!.pendingBytes ?? 0,
  };
}

const deck = { attachmentId: 'att_deck' };

describe('base.binary.upload', () => {
  it('reads the pieces in order, acks each one, and replies with what run returns', async () => {
    const { engine, runs, kinds } = build();
    const amara = await connect(engine);

    await amara.start('up-1', deck, 20);
    // The window is 16 bytes, so the client waits for an ack before the third piece.
    amara.piece('up-1', 1, piece(8, 1));
    amara.piece('up-1', 2, piece(8, 2));
    await settle();
    amara.piece('up-1', 3, piece(4, 3));
    await amara.end('up-1', 20);

    await settle();

    expect(amara.of('up-1')).toEqual([
      [
        '__uploadAck__',
        { receivedThrough: 0, savedThrough: 0, pieceBytes: 8, windowBytes: 16 },
        { upload: { id: 'up-1' } },
      ],
      ['__uploadAck__', { receivedThrough: 8, savedThrough: 0 }, { upload: { id: 'up-1' } }],
      ['__uploadAck__', { receivedThrough: 16, savedThrough: 8 }, { upload: { id: 'up-1' } }],
      ['__uploadAck__', { receivedThrough: 20, savedThrough: 16 }, { upload: { id: 'up-1' } }],
      ['__uploadDone__', { info: { size: 20 } }, { upload: { id: 'up-1' } }],
    ]);
    expect(runs).toEqual([
      { savedThrough: 0, state: undefined, offsets: [0, 8, 16], ended: 'done' },
    ]);
    // Only the start frame passes the intercepts.
    expect(kinds).toEqual(['upload-attachment:upload']);
  });

  it('finishes an empty file: run reads no pieces and replies', async () => {
    const { engine, runs } = build();
    const amara = await connect(engine);

    await amara.start('up-1', deck, 0);
    await amara.end('up-1', 0);
    await settle();

    expect(amara.of('up-1')).toEqual([
      [
        '__uploadAck__',
        { receivedThrough: 0, savedThrough: 0, pieceBytes: 8, windowBytes: 16 },
        { upload: { id: 'up-1' } },
      ],
      ['__uploadDone__', { info: { size: 0 } }, { upload: { id: 'up-1' } }],
    ]);
    expect(runs).toEqual([{ savedThrough: 0, state: undefined, offsets: [], ended: 'done' }]);
  });

  it('resumes from the saved offset on a new connection, with the saved state', async () => {
    const { engine, runs } = build();
    const first = await connect(engine);
    await first.start('up-1', deck);
    first.piece('up-1', 1, piece(8, 1));
    first.piece('up-1', 2, piece(8, 2));

    await settle();
    await first.close();
    await settle();

    const second = await connect(engine);
    await second.start('up-1', deck);
    await settle();
    expect(second.of('up-1')[0]).toEqual([
      '__uploadAck__',
      { receivedThrough: 16, savedThrough: 16, pieceBytes: 8, windowBytes: 16 },
      { upload: { id: 'up-1' } },
    ]);

    second.piece('up-1', 1, piece(4, 3));
    await second.end('up-1', 20);
    await settle();

    expect(runs.map((run) => [run.savedThrough, run.state, run.offsets, run.ended])).toEqual([
      [0, undefined, [0, 8], 'disconnected'],
      [16, { parts: 2 }, [16], 'done'],
    ]);
    expect(second.of('up-1').at(-1)).toEqual([
      '__uploadDone__',
      { info: { size: 20 } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('ignores the reply of a run that was stopped before it read every byte, and resumes later', async () => {
    const warned: unknown[][] = [];
    const logger = { info() {}, warn: (...args: unknown[]) => warned.push(args), error() {} };
    const { engine, runs } = build({ swallowStop: true, logger });
    const first = await connect(engine);
    await first.start('up-1', deck);

    first.piece('up-1', 1, piece(8, 1));

    await settle();
    await first.close();
    await settle();

    const second = await connect(engine);
    await second.start('up-1', deck);
    await settle();
    expect(second.of('up-1')[0]).toEqual([
      '__uploadAck__',
      { receivedThrough: 8, savedThrough: 8, pieceBytes: 8, windowBytes: 16 },
      { upload: { id: 'up-1' } },
    ]);

    second.piece('up-1', 1, piece(4, 2));
    await second.end('up-1', 12);
    await settle();

    expect(runs.map((run) => [run.savedThrough, run.offsets, run.ended])).toEqual([
      [0, [0], 'disconnected'],
      [8, [8], 'done'],
    ]);
    expect(second.of('up-1').at(-1)).toEqual([
      '__uploadDone__',
      { info: { size: 12 } },
      { upload: { id: 'up-1' } },
    ]);
    expect(warned).toEqual([
      [
        expect.stringContaining('returned after it was stopped'),
        expect.objectContaining({ event: 'upload-attachment', uploadId: 'up-1' }),
      ],
    ]);
  });

  it('keeps the reply of a stopped run that had already read every byte', async () => {
    const { engine, runs } = build({ swallowStop: true });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 8);

    await amara.close();
    await settle();

    const again = await connect(engine);
    await again.start('up-1', deck);
    await settle();

    expect(runs).toHaveLength(1);
    expect(again.of('up-1').at(-1)).toEqual([
      '__uploadDone__',
      { info: { size: 8 } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('sends the stored reply again, without running run, when a done upload starts again', async () => {
    const { engine, runs } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 8);

    await settle();

    await amara.start('up-1', deck);
    await settle();

    expect(runs).toHaveLength(1);
    expect(amara.of('up-1').filter((frame) => frame[0] === '__uploadDone__')).toEqual([
      ['__uploadDone__', { info: { size: 8 } }, { upload: { id: 'up-1' } }],
      ['__uploadDone__', { info: { size: 8 } }, { upload: { id: 'up-1' } }],
    ]);
  });

  it('cancels: stops run, runs onDiscard with what was saved, and forgets the upload', async () => {
    const { engine, runs, discarded } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    await amara.cancel('up-1');
    await settle();

    expect(runs[0]!.ended).toBe('upload-aborted');
    expect(discarded).toEqual([{ input: deck, savedThrough: 8, state: { parts: 1 } }]);

    // A new start is a new upload from 0.
    await amara.start('up-1', deck);
    await settle();
    expect(runs[1]!.savedThrough).toBe(0);
  });

  it('fails the upload when run throws: the client gets the error, and onDiscard runs', async () => {
    const { engine, discarded, hookErrors } = build({ throwAfter: 1 });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    expect(amara.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'internal-error' },
      { upload: { id: 'up-1' } },
    ]);
    expect(hookErrors).toEqual(['Error: the disk is full']);
    expect(discarded).toHaveLength(1);
  });

  it.each([
    ['a piece with the wrong seq', (c: any) => c.piece('up-1', 2, piece(8, 1)), 'bad-piece'],
    ['a piece over pieceBytes', (c: any) => c.piece('up-1', 1, piece(9, 1)), 'bad-piece'],
    ['an empty piece', (c: any) => c.piece('up-1', 1, NO_BYTES), 'bad-piece'],
    [
      'more bytes than the window',
      (c: any) => {
        for (let seq = 1; seq <= 3; seq += 1) c.piece('up-1', seq, piece(8, seq));
      },
      'window',
    ],
  ])('fails the upload on %s', async (_name, send, reason) => {
    // A run that never reads, so the window fills.
    const { engine, discarded } = build({ readGate: new Promise(() => {}) });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    send(amara);
    await settle();

    expect(amara.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason } },
      { upload: { id: 'up-1' } },
    ]);
    expect(discarded).toHaveLength(1);
  });

  it('refuses a start whose size is over maxBytes, before any piece', async () => {
    const { engine, runs } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck, 65);
    await settle();

    expect(runs).toEqual([]);
    expect(amara.of('up-1')).toEqual([
      [
        '__error__',
        { code: 'upload-aborted', detail: { reason: 'too-large' } },
        { upload: { id: 'up-1' } },
      ],
    ]);
  });

  it('refuses a resume with a different input', async () => {
    const { engine } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    await amara.close();
    await settle();

    const again = await connect(engine);
    await again.start('up-1', { attachmentId: 'att_other' });
    await settle();
    expect(again.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'input-mismatch' } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('refuses an anonymous connection', async () => {
    const { engine } = build();
    const anonymous = await connect(engine, '');
    await anonymous.start('up-1', deck);
    await settle();

    expect(anonymous.of('up-1')).toEqual([
      ['__error__', { code: 'durable-stream-requires-user' }, { upload: { id: 'up-1' } }],
    ]);
  });

  it('holds a piece against the connection until run reads it', async () => {
    let open!: () => void;
    const { engine } = build({ readGate: new Promise((resolve) => (open = resolve)) });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));

    await settle();
    expect(amara.pendingBytes()).toBeGreaterThan(8);

    open();
    await settle();
    expect(amara.pendingBytes()).toBe(0);
  });

  it('expires an idle upload: onDiscard runs, then the record is gone', async () => {
    const { engine, discarded, runs } = build({ uploads: { expireAfterMs: 50 } });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    await amara.close();
    await settle();

    await new Promise((resolve) => setTimeout(resolve, 80));
    await engine.handleAlarm();
    await settle();
    expect(discarded).toEqual([{ input: deck, savedThrough: 8, state: { parts: 1 } }]);

    const again = await connect(engine);
    await again.start('up-1', deck);
    await settle();
    expect(runs.at(-1)!.savedThrough).toBe(0);
  });

  it("limits how often an upload starts with the handler's rateLimit, and refuses the extra start", async () => {
    const { engine, runs } = build({ uploadRateLimit: { maxMessages: 1, windowMs: 60_000 } });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    await amara.start('up-2', deck);
    await settle();

    expect(runs).toHaveLength(1);
    expect(amara.of('up-1')[0]?.[0]).toBe('__uploadAck__');
    expect(amara.of('up-2')).toEqual([
      [
        '__error__',
        { code: 'rate-limited', detail: { retryAfterMs: expect.any(Number) } },
        { upload: { id: 'up-2' } },
      ],
    ]);
  });

  it('does not charge the pieces against the rate limit: only the start counts', async () => {
    const { engine, runs } = build({ rateLimit: { maxMessages: 2, windowMs: 60_000 } });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    for (let seq = 1; seq <= 6; seq += 1) {
      amara.piece('up-1', seq, piece(8, seq));
      await settle();
    }

    await amara.end('up-1', 48);
    await settle();
    expect(runs[0]!.offsets).toEqual([0, 8, 16, 24, 32, 40]);
    expect(amara.of('up-1').at(-1)).toEqual([
      '__uploadDone__',
      { info: { size: 48 } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('refuses an upload rateLimit without the rateLimit() capability', () => {
    const base = server({ capabilities: [binary(), uploads()] });
    const handleUploadAttachment = base.binary.upload('upload-attachment', {
      ...({ rateLimit: { maxMessages: 1 } } as object),
      run: async () => ({ info: null }),
    });
    expect(() => base.assemble({ handlers: [handleUploadAttachment] })).toThrow(
      /per-handler rateLimit override needs the rateLimit\(\) capability/,
    );
  });

  it('needs uploads() for base.binary.upload', () => {
    const base = server({ capabilities: [binary()] });
    expect(() =>
      (base.binary as any).upload('upload-attachment', { run: async () => ({ info: null }) }),
    ).toThrow(LiveThingConfigError);
  });

  it('checks ctx.upload.saved(): no going back, nothing past the bytes read, state up to 64 KiB', async () => {
    const { engine, probeErrors } = build({
      afterRead(upload) {
        upload.saved(upload.savedThrough - 1);
      },
    });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    expect(probeErrors).toHaveLength(1);
    expect(probeErrors[0]).toMatch(/from 8 \(the last saved offset\) to 8/);
  });

  it.each([
    ['an offset past the bytes read', (upload: any) => upload.saved(upload.savedThrough + 1)],
    ['a state over 64 KiB', (upload: any) => upload.saved(8, { state: 'x'.repeat(70_000) })],
    ['an offset that is not a whole number', (upload: any) => upload.saved(7.5)],
  ])('ctx.upload.saved() throws a RangeError for %s', async (_name, call) => {
    const { engine, probeErrors } = build({ afterRead: call });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    expect(probeErrors).toHaveLength(1);
  });

  it.each([
    ['no info key', {}],
    ['an array as the info', { info: [1] }],
  ])('fails the upload when run returns %s', async (_name, reply) => {
    const { engine, discarded } = build({ reply });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 8);

    await settle();

    expect(amara.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'internal-error' },
      { upload: { id: 'up-1' } },
    ]);
    expect(discarded).toHaveLength(1);
  });

  it('fails an upload with no size once its pieces go over maxBytes', async () => {
    const { engine } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    for (let seq = 1; seq <= 9; seq += 1) {
      amara.piece('up-1', seq, piece(8, seq));
      await settle();
    }

    expect(amara.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'too-large' } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('fails the upload on a second end frame', async () => {
    const { engine } = build({ readGate: new Promise(() => {}) });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 16);

    await amara.end('up-1', 16);
    await settle();

    expect(amara.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'bad-piece' } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('refuses a resume whose size differs from the stored one', async () => {
    const { engine } = build();
    const first = await connect(engine);
    await first.start('up-1', deck, 20);
    await first.close();
    await settle();

    const second = await connect(engine);
    await second.start('up-1', deck, 30);
    await settle();
    expect(second.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'input-mismatch' } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('refuses a resume that sends a size when the first start sent none', async () => {
    const { engine, runs } = build();
    const first = await connect(engine);
    await first.start('up-1', deck);
    first.piece('up-1', 1, piece(8, 1));
    await settle();

    await first.close();
    await settle();

    const second = await connect(engine);
    await second.start('up-1', deck, 12);
    await settle();

    expect(runs).toHaveLength(1);
    expect(second.of('up-1')).toEqual([
      [
        '__error__',
        { code: 'upload-aborted', detail: { reason: 'input-mismatch' } },
        { upload: { id: 'up-1' } },
      ],
    ]);
  });

  it('refuses a resume that sends no size when the first start sent one', async () => {
    const { engine } = build();
    const first = await connect(engine);
    await first.start('up-1', deck, 20);
    await first.close();
    await settle();

    const second = await connect(engine);
    await second.start('up-1', deck);
    await settle();

    expect(second.of('up-1')).toEqual([
      [
        '__error__',
        { code: 'upload-aborted', detail: { reason: 'input-mismatch' } },
        { upload: { id: 'up-1' } },
      ],
    ]);
  });

  it('refuses a start of a done upload with a different size, instead of sending the stored reply', async () => {
    const { engine, runs } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck, 8);
    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 8);

    await settle();

    const again = await connect(engine);
    await again.start('up-1', deck, 9);
    await settle();

    expect(runs).toHaveLength(1);
    expect(again.of('up-1')).toEqual([
      [
        '__error__',
        { code: 'upload-aborted', detail: { reason: 'input-mismatch' } },
        { upload: { id: 'up-1' } },
      ],
    ]);
  });

  it('refuses a start frame with no upload metadata', async () => {
    const { engine, runs } = build();
    const amara = await connect(engine);
    await amara.startWith(null);
    await settle();

    expect(runs).toEqual([]);
    const [event, payload] = amara.frames().at(-1)!;
    expect([event, payload.code]).toEqual(['__error__', 'validation-failed']);
  });

  it('tells the connection once that an upload is not running here, as after an eviction', async () => {
    const { engine } = build();
    const amara = await connect(engine);
    amara.piece('up-gone', 1, piece(8, 1));
    amara.piece('up-gone', 2, piece(8, 2));
    await amara.end('up-gone', 16);

    await settle();

    const interrupted = [
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'interrupted' } },
      { upload: { id: 'up-gone' } },
    ];
    expect(amara.frames()).toEqual([interrupted]);
    expect(amara.pendingBytes()).toBe(0);

    // A new start clears it, so a later loss is told again.
    await amara.start('up-gone', deck);
    await amara.cancel('up-gone');
    await settle();
    amara.piece('up-gone', 1, piece(8, 1));
    await settle();

    expect(
      amara.frames().filter((frame) => frame[1]?.detail?.reason === 'interrupted'),
    ).toHaveLength(2);
  });

  it('drops a late piece from a connection whose upload another connection took over', async () => {
    const { engine } = build({ readGate: new Promise(() => {}) });
    const first = await connect(engine);
    await first.start('up-1', deck);
    const second = await connect(engine);
    await second.start('up-1', deck);

    await settle();
    expect(first.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'taken-over' } },
      { upload: { id: 'up-1' } },
    ]);

    const before = first.frames().length;
    first.piece('up-1', 1, piece(8, 1));
    await settle();
    expect(first.frames()).toHaveLength(before);
    expect(second.of('up-1').at(-1)?.[0]).toBe('__uploadAck__');
  });

  it('fails the upload when a piece names another event', async () => {
    const { engine } = build({ readGate: new Promise(() => {}) });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    await amara.pieceAs('upload-avatar', piece(8, 1));
    await settle();

    expect(amara.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'bad-piece' } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('refuses a resume that a cancel overtook, and discards the stored upload', async () => {
    const { engine, runs, discarded } = build({ slowStartMs: 200 });
    const first = await connect(engine);
    await first.start('up-1', deck);
    first.piece('up-1', 1, piece(8, 1));
    await settle();

    await first.close();
    await settle();

    const second = await connect(engine);
    const starting = second.start('up-1', deck);
    await second.cancel('up-1');
    await starting;
    await settle();

    expect(runs).toHaveLength(1);
    expect(discarded).toHaveLength(1);
    expect(second.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'cancelled' } },
      { upload: { id: 'up-1' } },
    ]);

    // Nothing is left over: a new start of the same id on this connection runs.
    await second.start('up-1', deck);
    await settle();
    expect(runs).toHaveLength(2);
  });

  it('refuses a start that a cancel overtook, so nothing runs and nothing is stored', async () => {
    const { engine, runs, discarded } = build({ slowStartMs: 200 });
    const amara = await connect(engine);
    const starting = amara.start('up-1', deck);
    await amara.cancel('up-1');
    await starting;

    await settle();

    expect(runs).toEqual([]);
    expect(discarded).toEqual([]);
    expect(amara.of('up-1')).toEqual([
      [
        '__error__',
        { code: 'upload-aborted', detail: { reason: 'cancelled' } },
        { upload: { id: 'up-1' } },
      ],
    ]);
  });

  it('lets a takeover go on when the old run ignores its signal for the grace time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let wake!: () => void;
      const { engine, runs, probeErrors } = build({
        hang: new Promise((resolve) => (wake = resolve)),
      });
      const first = await connect(engine);
      await first.start('up-1', deck);
      first.piece('up-1', 1, piece(8, 1));

      await vi.advanceTimersByTimeAsync(10);

      const second = await connect(engine);
      const takingOver = second.start('up-1', deck);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(runs).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2_000);
      await takingOver;
      expect(runs).toHaveLength(2);
      expect(runs[1]!.savedThrough).toBe(8);

      // The new run saves; the old one wakes late and must not write over that.
      second.piece('up-1', 1, piece(8, 2));
      await vi.advanceTimersByTimeAsync(10);
      wake();
      await vi.advanceTimersByTimeAsync(10);
      expect(probeErrors).toEqual(['upload-aborted']);

      const third = await connect(engine, 'u_amara');
      await second.close();
      await vi.advanceTimersByTimeAsync(10);
      await third.start('up-1', deck);
      await vi.advanceTimersByTimeAsync(10);

      expect(runs.at(-1)!.savedThrough).toBe(16);
      expect(runs.at(-1)!.state).toEqual({ parts: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a start that its connection cancelled while it waited for a dropped run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { engine, runs, discarded } = build({ hang: new Promise(() => {}) });
      const first = await connect(engine);
      await first.start('up-1', deck);
      first.piece('up-1', 1, piece(8, 1));
      await vi.advanceTimersByTimeAsync(10);

      await first.close();

      const second = await connect(engine);
      const starting = second.start('up-1', deck);
      await vi.advanceTimersByTimeAsync(5_000);
      const cancelling = second.cancel('up-1');
      await vi.advanceTimersByTimeAsync(11_000);

      await Promise.all([starting, cancelling]);

      expect(runs).toHaveLength(1);
      expect(discarded).toHaveLength(1);
      expect(second.of('up-1').at(-1)).toEqual([
        '__error__',
        { code: 'upload-aborted', detail: { reason: 'cancelled' } },
        { upload: { id: 'up-1' } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a start whose own connection cancelled it while it waited for a takeover', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { engine, runs, discarded } = build({ hang: new Promise(() => {}) });
      const first = await connect(engine);
      await first.start('up-1', deck);
      first.piece('up-1', 1, piece(8, 1));
      await vi.advanceTimersByTimeAsync(10);

      const second = await connect(engine);
      const starting = second.start('up-1', deck);
      await vi.advanceTimersByTimeAsync(5_000);
      const cancelling = second.cancel('up-1');
      await vi.advanceTimersByTimeAsync(11_000);

      await Promise.all([starting, cancelling]);

      expect(runs).toHaveLength(1);
      expect(discarded).toHaveLength(1);
      expect(second.of('up-1').at(-1)).toEqual([
        '__error__',
        { code: 'upload-aborted', detail: { reason: 'cancelled' } },
        { upload: { id: 'up-1' } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards a failed upload whose run does not stop, once the grace time is over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { engine, discarded } = build({ hang: new Promise(() => {}) });
      const amara = await connect(engine);
      await amara.start('up-1', deck);
      amara.piece('up-1', 1, piece(8, 1));
      await vi.advanceTimersByTimeAsync(10);

      amara.piece('up-1', 5, piece(8, 2));
      await vi.advanceTimersByTimeAsync(10);
      expect(discarded).toEqual([]);

      await vi.advanceTimersByTimeAsync(11_000);
      expect(discarded).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms the alarm for a purged upload whose run does not stop, once the grace time is over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { engine, timers } = build({ hang: new Promise(() => {}) });
      const amara = await connect(engine);
      await amara.start('up-1', deck);
      amara.piece('up-1', 1, piece(8, 1));
      await vi.advanceTimersByTimeAsync(10);

      await (engine.admin() as any).purgeUser('u_amara');
      await vi.advanceTimersByTimeAsync(10);
      expect(timers.getAlarm()).toBeNull();

      await vi.advanceTimersByTimeAsync(11_000);
      expect(timers.getAlarm()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells one connection about at most 32 uploads it is not running', async () => {
    const { engine } = build();
    const amara = await connect(engine);
    for (let index = 0; index < 40; index += 1) amara.piece(`up-${index}`, 1, piece(8, 1));
    await settle();
    expect(amara.frames()).toHaveLength(32);
  });

  it('refuses a start that a cancel overtook only on the connection that sent the cancel', async () => {
    const { engine, runs } = build();
    const first = await connect(engine);
    await first.cancel('up-1');
    const second = await connect(engine);
    await second.start('up-1', deck);

    await settle();
    expect(runs).toHaveLength(1);
  });

  it('fails the upload, and discards it, when its reply cannot be stored', async () => {
    const { engine, discarded } = build({
      onExec(query) {
        if (query.includes("status = 'done'")) throw new Error('the row is too big');
      },
    });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 8);

    await settle();

    expect(amara.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'internal-error' },
      { upload: { id: 'up-1' } },
    ]);
    expect(discarded).toHaveLength(1);
  });

  it('cancels an upload that is not running: onDiscard runs for its record', async () => {
    const { engine, discarded } = build();
    const first = await connect(engine);
    await first.start('up-1', deck);
    first.piece('up-1', 1, piece(8, 1));
    await settle();

    await first.close();
    await settle();

    const second = await connect(engine);
    await second.cancel('up-1');
    await settle();
    expect(discarded).toEqual([{ input: deck, savedThrough: 8, state: { parts: 1 } }]);
  });

  it('keeps the reply of a done upload when it is cancelled after it finished', async () => {
    const { engine, discarded } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 8);

    await settle();
    await amara.cancel('up-1');
    await amara.start('up-1', deck);
    await settle();

    expect(discarded).toEqual([]);
    expect(amara.of('up-1').at(-1)).toEqual([
      '__uploadDone__',
      { info: { size: 8 } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('runs onDiscard again on a later sweep when it throws', async () => {
    const { engine, discarded } = build({ discardFailures: 1 });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    await settle();
    await amara.cancel('up-1');

    await settle();
    expect(discarded).toEqual([]);

    const later = Date.now() + 61_000;
    const realNow = Date.now;
    Date.now = () => later;
    try {
      await engine.handleAlarm();
      await settle();
    } finally {
      Date.now = realNow;
    }

    expect(discarded).toHaveLength(1);
  });

  it('arms the alarm for the end of a done reply, and for the expiry of a dropped upload', async () => {
    const { engine, timers } = build({
      uploads: { expireAfterMs: 5_000, retentionAfterDoneMs: 3_000 },
    });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 8);

    await settle();
    expect(timers.getAlarm()! - Date.now()).toBeGreaterThan(2_000);
    expect(timers.getAlarm()! - Date.now()).toBeLessThanOrEqual(3_000);

    await engine.handleAlarm();
    const dropped = await connect(engine, 'u_kofi');
    await dropped.start('up-2', deck);
    await dropped.close();
    await settle();

    expect(timers.getAlarm()! - Date.now()).toBeGreaterThan(2_000);
    expect(timers.getAlarm()! - Date.now()).toBeLessThanOrEqual(5_000);
  });

  it('stops a purged user’s uploads, tells the client, and discards them on the next sweep', async () => {
    const { engine, discarded } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    await (engine.admin() as any).purgeUser('u_amara');
    await settle();
    expect(amara.of('up-1')).toContainEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'gone' } },
      { upload: { id: 'up-1' } },
    ]);

    await engine.handleAlarm();
    await settle();
    expect(discarded).toEqual([{ input: deck, savedThrough: 8, state: { parts: 1 } }]);
  });

  it.each([
    [
      'windowBytes below pieceBytes',
      () =>
        server({ capabilities: [binary(), uploads()] }).binary.upload('upload-attachment', {
          pieceBytes: 16,
          windowBytes: 8,
          run: async () => ({ info: null }),
        }),
    ],
    [
      'a pieceBytes that is not a positive integer',
      () =>
        server({ capabilities: [binary(), uploads()] }).binary.upload('upload-attachment', {
          pieceBytes: 0,
          run: async () => ({ info: null }),
        }),
    ],
    ['an expireAfterMs of 0', () => uploads({ expireAfterMs: 0 })],
    ['an unknown uploads() option', () => uploads({ keepFor: 1 } as never)],
  ])('refuses %s', (_name, make) => {
    expect(make).toThrow();
  });

  it('refuses a pieceBytes that does not fit the receive limit, at startup', async () => {
    const base = server({ capabilities: [binary(), uploads()] });
    const handleUploadAttachment = base.binary.upload('upload-attachment', {
      pieceBytes: 4096,
      windowBytes: 8192,
      run: async () => ({ info: null }),
    });
    const definition = base.assemble({ handlers: [handleUploadAttachment] });
    let engine!: Engine;
    adapter({
      id: 'upload-limit-spec',
      asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
      setup(createEngine) {
        engine = createEngine({
          storage: { sql: createTestSql(), kv: createTestKV() },
          timers: createTestTimers(),
          platform: {},
          logger: { info() {}, warn() {}, error() {} },
          messageLimits: { receiveBytes: 4096, sendBytes: 4096 },
        });
        return {};
      },
    })(definition, undefined as never);

    await expect(engine.initialize()).rejects.toThrow(/pieceBytes/);
  });

  it('refuses a pieceBytes that does not fit the POST limit of server-sent events, at startup', async () => {
    const base = server({ capabilities: [binary(), uploads()] });
    const handleUploadAttachment = base.binary.upload('upload-attachment', {
      pieceBytes: 64 * 1024,
      run: async () => ({ info: null }),
    });
    const definition = base.assemble({ handlers: [handleUploadAttachment] });
    let engine!: Engine;
    adapter({
      id: 'upload-post-limit-spec',
      asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
      setup(createEngine) {
        engine = createEngine({
          storage: { sql: createTestSql(), kv: createTestKV() },
          timers: createTestTimers(),
          platform: {},
          logger: { info() {}, warn() {}, error() {} },
          messageLimits: {
            receiveBytes: 1024 * 1024,
            sendBytes: 1024 * 1024,
            postBytes: 64 * 1024,
          },
        });
        return {};
      },
    })(definition, undefined as never);

    await expect(engine.initialize()).rejects.toThrow(/does not fit http\(\) maxPostBytes/);
  });

  it('refuses a window that does not fit half the connection budget, at startup', async () => {
    const base = server({ capabilities: [binary(), uploads()] });
    const handleUploadAttachment = base.binary.upload('upload-attachment', {
      pieceBytes: 1024,
      windowBytes: 16 * 1024,
      run: async () => ({ info: null }),
    });
    const definition = base.assemble({ handlers: [handleUploadAttachment] });
    let engine!: Engine;
    adapter({
      id: 'upload-window-spec',
      asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
      setup(createEngine) {
        engine = createEngine({
          storage: { sql: createTestSql(), kv: createTestKV() },
          timers: createTestTimers(),
          platform: {},
          logger: { info() {}, warn() {}, error() {} },
          messageLimits: { receiveBytes: 16 * 1024, sendBytes: 16 * 1024 },
        });
        return {};
      },
    })(definition, undefined as never);

    await expect(engine.initialize()).rejects.toThrow(/windowBytes/);
  });

  it('refuses an upload event that is also a request', () => {
    const base = server({ capabilities: [binary(), uploads(), clientRequests()] });
    const handleUpload = base.binary.upload('upload-attachment', {
      run: async () => ({ info: null }),
    });
    const handleRequest = base.request('upload-attachment', { run: () => null });
    expect(() => {
      const definition = base.assemble({ handlers: [handleUpload, handleRequest] as never });
      adapter({
        id: 'upload-collision-spec',
        asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
        setup(createEngine) {
          createEngine({
            storage: { sql: createTestSql(), kv: createTestKV() },
            timers: createTestTimers(),
            platform: {},
            logger: { info() {}, warn() {}, error() {} },
          });
          return {};
        },
      })(definition, undefined as never);
    }).toThrow(/upload/);
  });
});

/** Create an engine for a definition, on its own database unless one is given. */
function engineOf(definition: unknown, sql = createTestSql()) {
  let engine!: Engine;
  const timers = createTestTimers();
  adapter({
    id: 'upload-docs-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql, kv: createTestKV() },
        timers,
        platform: {},
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  })(definition as never, undefined as never);

  return { engine, timers, sql };
}

function rows(sql: ReturnType<typeof createTestSql>): any[] {
  return sql.db.prepare('SELECT * FROM __livething_uploads').all();
}

describe('base.binary.upload: what the docs promise', () => {
  it('uses 100 MiB, 256 KiB and 2 MiB when the handler sets no sizes', async () => {
    const base = server({ capabilities: [binary(), uploads()] });
    const handleUploadAttachment = base.binary.upload('upload-attachment', {
      async run(_ctx, _input, pieces) {
        for await (const _piece of pieces);
        return { info: null };
      },
    });
    const { engine } = engineOf(base.assemble({ handlers: [handleUploadAttachment] }));
    const amara = await connect(engine);

    await amara.start('up-1', null, 100 * 1024 * 1024);
    await amara.start('up-2', null, 100 * 1024 * 1024 + 1);
    await settle();

    expect(amara.of('up-1')[0]).toEqual([
      '__uploadAck__',
      { receivedThrough: 0, savedThrough: 0, pieceBytes: 262_144, windowBytes: 2_097_152 },
      { upload: { id: 'up-1' } },
    ]);
    expect(amara.of('up-2')).toEqual([
      [
        '__error__',
        { code: 'upload-aborted', detail: { reason: 'too-large' } },
        { upload: { id: 'up-2' } },
      ],
    ]);
  });

  it('keeps a done reply for 10 minutes by default', async () => {
    const { engine, timers } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 8);

    await settle();

    const left = timers.getAlarm()! - Date.now();
    expect(left).toBeGreaterThan(9 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000);
  });

  it('expires a dropped upload after 24 hours by default', async () => {
    const { engine, timers } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    await amara.close();
    await settle();

    const left = timers.getAlarm()! - Date.now();
    expect(left).toBeGreaterThan(23 * 3_600_000);
    expect(left).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('deletes a done reply after retentionAfterDoneMs, so a new start runs again from 0', async () => {
    const { engine, runs, sql } = build({ uploads: { retentionAfterDoneMs: 30 } });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 8);

    await settle();

    await new Promise((resolve) => setTimeout(resolve, 50));
    await engine.handleAlarm();
    expect(rows(sql)).toEqual([]);

    await amara.start('up-1', deck);
    await settle();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.savedThrough).toBe(0);
  });

  it('checks the input of the start, and refuses a bad one before run', async () => {
    const { engine, runs, sql } = build();
    const amara = await connect(engine);
    await amara.start('up-1', { attachmentId: 42 });
    await settle();

    expect(runs).toEqual([]);
    expect(rows(sql)).toEqual([]);
    expect(amara.of('up-1').at(-1)?.[1]?.code).toBe('validation-failed');
  });

  it('refuses an upload id over 128 characters', async () => {
    const { engine, runs } = build();
    const amara = await connect(engine);
    await amara.start('x'.repeat(129), deck);
    await settle();

    expect(runs).toEqual([]);
    expect(amara.frames().at(-1)?.[0]).toBe('__error__');
  });

  it('does not run onDiscard on a drop, and keeps the record', async () => {
    const { engine, discarded, sql } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    await amara.close();
    await settle();

    expect(discarded).toEqual([]);
    expect(rows(sql)).toMatchObject([{ upload_id: 'up-1', status: 'active', saved_through: 8 }]);
  });

  it.each([
    {
      name: 'a cancel',
      stop: (c: any) => c.cancel('up-1'),
      code: 'upload-aborted',
      reason: 'cancelled',
    },
    {
      name: 'a closed connection',
      stop: (c: any) => c.close(),
      code: 'disconnected',
      reason: undefined,
    },
    {
      name: 'a takeover',
      stop: async (_c: any, engine: Engine) => (await connect(engine)).start('up-1', deck),
      code: 'upload-aborted',
      reason: 'taken-over',
    },
  ])('fires ctx.upload.signal on $name', async ({ stop, code, reason }) => {
    let signal!: AbortSignal;
    const { engine } = build({
      afterRead(upload) {
        signal = upload.signal;
      },
    });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));

    await settle();
    expect(signal.aborted).toBe(false);

    await stop(amara, engine);
    await settle();

    expect(signal.aborted).toBe(true);
    expect((signal.reason as any).code).toBe(code);
    expect((signal.reason as any).detail?.reason).toBe(reason);
  });

  it('fails an upload whose bytes go over the size at the start, and discards it', async () => {
    const { engine, discarded } = build({ readGate: new Promise(() => {}) });
    const amara = await connect(engine);
    await amara.start('up-1', deck, 12);
    amara.piece('up-1', 1, piece(8, 1));
    amara.piece('up-1', 2, piece(8, 2));

    await settle();

    expect(amara.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'too-large' } },
      { upload: { id: 'up-1' } },
    ]);
    expect(discarded).toHaveLength(1);
  });

  it('fails an upload whose end total differs from the size at the start', async () => {
    const { engine, discarded } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck, 16);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    await amara.end('up-1', 8);
    await settle();

    expect(amara.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'bad-piece' } },
      { upload: { id: 'up-1' } },
    ]);
    expect(discarded).toHaveLength(1);
  });

  it('ends the loop only once it has read totalBytes, even when the end comes first', async () => {
    const { engine, runs } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck, 12);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    await amara.end('up-1', 12);
    await settle();
    expect(runs[0]!.ended).toBeUndefined();

    amara.piece('up-1', 2, piece(4, 2));
    await settle();
    expect(runs[0]!.ended).toBe('done');
    expect(amara.of('up-1').at(-1)).toEqual([
      '__uploadDone__',
      { info: { size: 12 } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('never expires an upload that a connection is running, even when run is slow', async () => {
    const { engine, discarded, runs } = build({
      uploads: { expireAfterMs: 20 },
      readGate: new Promise(() => {}),
    });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await engine.handleAlarm();

    await settle();

    expect(discarded).toEqual([]);
    expect(runs[0]!.ended).toBeUndefined();
  });

  it("refuses with 'gone' a start of an upload whose onDiscard has not succeeded yet", async () => {
    const { engine } = build({ discardFailures: 1 });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    await settle();
    await amara.cancel('up-1');

    await settle();

    await amara.start('up-1', deck);
    await settle();
    expect(amara.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'gone' } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('does not take over the same upload id of another user', async () => {
    const { engine, runs } = build({ readGate: new Promise(() => {}) });
    const amara = await connect(engine, 'u_amara');
    await amara.start('up-1', deck);
    const kofi = await connect(engine, 'u_kofi');
    await kofi.start('up-1', deck);

    await settle();

    expect(runs).toHaveLength(2);
    expect(amara.of('up-1').map((frame) => frame[0])).toEqual(['__uploadAck__']);
  });

  it('resumes with the state saved at offset 0, from the first byte', async () => {
    const { engine, runs } = build({
      saveEvery: false,
      afterRead(upload) {
        upload.saved(0, { state: ['att_1', 'att_2'] });
      },
    });
    const first = await connect(engine);
    await first.start('up-1', deck);
    first.piece('up-1', 1, piece(8, 1));
    await settle();

    await first.close();
    await settle();

    const second = await connect(engine);
    await second.start('up-1', deck);
    second.piece('up-1', 1, piece(8, 1));
    await settle();

    expect(runs[1]).toMatchObject({ savedThrough: 0, state: ['att_1', 'att_2'], offsets: [0] });
  });

  it('keeps one row per upload in __livething_uploads, with the reply once done', async () => {
    const { engine, sql } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck, 8);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    expect(rows(sql)).toEqual([
      {
        user_id: 'u_amara',
        upload_id: 'up-1',
        event: 'upload-attachment',
        input: JSON.stringify(deck),
        size: 8,
        saved_through: 8,
        state: JSON.stringify({ parts: 1 }),
        status: 'active',
        reply: null,
        updated_at: expect.any(Number),
      },
    ]);

    await amara.end('up-1', 8);
    await settle();
    expect(rows(sql)).toMatchObject([{ status: 'done', reply: JSON.stringify({ size: 8 }) }]);
  });

  it('moves updated_at for a piece at most once a minute', async () => {
    const { engine, sql } = build({ saveEvery: false });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    const startedAt = rows(sql)[0].updated_at;

    const realNow = Date.now;
    try {
      Date.now = () => startedAt + 30_000;
      amara.piece('up-1', 1, piece(8, 1));
      await settle();
      expect(rows(sql)[0].updated_at).toBe(startedAt);

      Date.now = () => startedAt + 61_000;
      amara.piece('up-1', 2, piece(8, 2));
      await settle();
      expect(rows(sql)[0].updated_at).toBe(startedAt + 61_000);
    } finally {
      Date.now = realNow;
    }
  });

  it('keeps the record when the server restarts: a piece gets interrupted, then a start resumes', async () => {
    const sql = createTestSql();
    const before = build({ sql });
    const amara = await connect(before.engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));

    await settle();

    const after = build({ sql });
    const again = await connect(after.engine);
    again.piece('up-1', 2, piece(8, 2));
    await settle();
    expect(again.of('up-1')).toEqual([
      [
        '__error__',
        { code: 'upload-aborted', detail: { reason: 'interrupted' } },
        { upload: { id: 'up-1' } },
      ],
    ]);

    await again.start('up-1', deck);
    await settle();
    expect(after.runs[0]).toMatchObject({ savedThrough: 8, state: { parts: 1 } });
  });

  it('expires an upload when the server starts, after it was down', async () => {
    const sql = createTestSql();
    const before = build({ sql, uploads: { expireAfterMs: 20 } });
    const amara = await connect(before.engine);
    await amara.start('up-1', deck);
    await amara.close();

    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = build({ sql, uploads: { expireAfterMs: 20 } });
    await after.engine.initialize();
    await settle();

    expect(after.discarded).toHaveLength(1);
    expect(rows(sql)).toEqual([]);
  });

  it("refuses a resume of the same upload id under another event with 'input-mismatch'", async () => {
    const base = server({ capabilities: [binary(), uploads()] });
    async function run(_ctx: any, _input: any, pieces: AsyncIterable<unknown>) {
      for await (const _piece of pieces);
      return { info: null };
    }

    const handleUploadAttachment = base.binary.upload('upload-attachment', { run });
    const handleUploadVoiceNote = base.binary.upload('upload-voice-note', { run });
    const { engine } = engineOf(
      base.assemble({ handlers: [handleUploadAttachment, handleUploadVoiceNote] }),
    );

    const first = await connect(engine);
    await first.start('up-1', null);
    await first.close();
    await settle();

    const second = await connect(engine);
    await second.startAs('upload-voice-note', 'up-1', null);
    await settle();
    expect(second.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'upload-aborted', detail: { reason: 'input-mismatch' } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('gives onDiscard the input as JSON, and a ctx with no ctx.send', async () => {
    const seen: { input: unknown; hasSend: boolean }[] = [];
    const runInputs: unknown[] = [];
    const base = server({ capabilities: [binary(), uploads()] });
    const handleUploadAttachment = base.binary.upload('upload-attachment', {
      input: v.object({
        sentAt: v.pipe(
          v.string(),
          v.transform((text) => new Date(text)),
        ),
      }),
      async run(_ctx, input, pieces) {
        runInputs.push(input.sentAt);
        for await (const _piece of pieces);
        return { info: null };
      },
      onDiscard(ctx, input) {
        seen.push({ input, hasSend: typeof (ctx as any).send === 'function' });
      },
    });
    const { engine } = engineOf(base.assemble({ handlers: [handleUploadAttachment] }));

    const amara = await connect(engine);
    await amara.start('up-1', { sentAt: '2026-11-07T10:00:00.000Z' });
    await settle();
    await amara.cancel('up-1');
    await settle();

    expect(runInputs[0]).toBeInstanceOf(Date);
    expect(seen).toEqual([{ input: { sentAt: '2026-11-07T10:00:00.000Z' }, hasSend: false }]);
  });

  it('a cancel after the last piece only fires the signal: run goes on, and nothing is posted', async () => {
    let letGo!: () => void;
    const gate = new Promise<void>((resolve) => (letGo = resolve));
    const seen: { abortedBeforeGate?: boolean; abortedAfterGate?: boolean; threw?: boolean } = {};
    const discarded: unknown[] = [];
    const base = server({ capabilities: [binary(), uploads()] });

    const handleUploadAttachment = base.binary.upload('upload-attachment', {
      pieceBytes: 8,
      windowBytes: 16,
      async run(ctx, _input, pieces) {
        try {
          for await (const _piece of pieces);
          seen.abortedBeforeGate = ctx.upload.signal.aborted;
          await gate;
          seen.abortedAfterGate = ctx.upload.signal.aborted;
          seen.threw = false;
        } catch {
          seen.threw = true;
        }

        return { info: null };
      },
      onDiscard(_ctx, input) {
        discarded.push(input);
      },
    });
    const { engine } = engineOf(base.assemble({ handlers: [handleUploadAttachment] }));
    const amara = await connect(engine);

    await amara.start('up-1', null);
    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 8);
    await settle();

    const cancelling = amara.cancel('up-1');
    await settle();
    letGo();
    await cancelling;
    await settle();

    expect(seen).toEqual({ abortedBeforeGate: false, abortedAfterGate: true, threw: false });
    expect(amara.of('up-1').map((frame) => frame[0])).not.toContain('__uploadDone__');
    expect(discarded).toHaveLength(1);
  });

  it('sends a registered error from run with its code and detail', async () => {
    const StorageFull = defineError('storage-full', v.object({ freeBytes: v.number() }));
    const base = server({ capabilities: [binary(), uploads(), errors([StorageFull])] });
    const handleUploadAttachment = base.binary.upload('upload-attachment', {
      async run() {
        throw StorageFull({ freeBytes: 0 });
      },
    });
    const { engine } = engineOf(base.assemble({ handlers: [handleUploadAttachment] }));
    const amara = await connect(engine);

    await amara.start('up-1', null);
    await settle();

    expect(amara.of('up-1').at(-1)).toEqual([
      '__error__',
      { code: 'storage-full', detail: { freeBytes: 0 } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('answers __uploadEnd__ and __uploadCancel__ with unsupported-protocol without uploads()', async () => {
    const base = server({ capabilities: [binary()] });
    const { engine } = engineOf(base.assemble({ handlers: [] }));
    const amara = await connect(engine);
    await amara.end('up-1', 8);
    await amara.cancel('up-1');

    await settle();

    expect(amara.frames().map((frame) => [frame[1]?.code, frame[1]?.detail?.event])).toEqual([
      ['unsupported-protocol', '__uploadEnd__'],
      ['unsupported-protocol', '__uploadCancel__'],
    ]);
  });

  it('refuses uploads() without binary()', () => {
    expect(() => {
      const base = server({ capabilities: [uploads()] });
      const handleUploadAttachment = (base as any).binary.upload('upload-attachment', {
        run: async () => ({ info: null }),
      });
      engineOf(base.assemble({ handlers: [handleUploadAttachment] }));
    }).toThrow();
  });

  it.each([
    ['an empty name', ''],
    ['a name over 128 characters', 'x'.repeat(129)],
    ['a name that starts with __', '__upload-attachment'],
    ['a name that ends with __', 'upload-attachment__'],
    ['a name with ::', 'files::upload-attachment'],
  ])('refuses %s', (_name, event) => {
    const base = server({ capabilities: [binary(), uploads()] });
    expect(() => {
      const handleUpload = base.binary.upload(event, { run: async () => ({ info: null }) });
      engineOf(base.assemble({ handlers: [handleUpload] }));
    }).toThrow();
  });

  it.each([
    ['a JSON event', (base: any) => base.on('upload-attachment', { run() {} })],
    ['a binary event', (base: any) => base.binary.on('upload-attachment', { run() {} })],
  ])('refuses an upload event that is also %s', (_name, other) => {
    const base = server({ capabilities: [binary(), uploads()] });
    const handleUpload = base.binary.upload('upload-attachment', {
      run: async () => ({ info: null }),
    });
    expect(() =>
      engineOf(base.assemble({ handlers: [handleUpload, other(base)] as never })),
    ).toThrow(/upload-attachment/);
  });

  it.each([
    ['an offset that goes back', (upload: any) => upload.saved(upload.savedThrough - 1)],
    ['an offset past the bytes read', (upload: any) => upload.saved(upload.savedThrough + 1)],
    [
      'a state of 64 KiB + 1 byte of JSON',
      (upload: any) => upload.saved(8, { state: 'x'.repeat(64 * 1024 - 1) }),
    ],
  ])('ctx.upload.saved() throws a RangeError for %s', async (_name, call) => {
    const thrown: unknown[] = [];
    const { engine } = build({
      afterRead(upload) {
        try {
          call(upload);
        } catch (error) {
          thrown.push(error);
        }
      },
    });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));

    await settle();

    expect(thrown).toHaveLength(1);
    expect(thrown[0]).toBeInstanceOf(RangeError);
  });

  it('ctx.upload.saved() takes a state of exactly 64 KiB of JSON', async () => {
    const thrown: unknown[] = [];
    const { engine, sql } = build({
      afterRead(upload) {
        try {
          upload.saved(8, { state: 'x'.repeat(64 * 1024 - 2) });
        } catch (error) {
          thrown.push(error);
        }
      },
    });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));

    await settle();

    expect(thrown).toEqual([]);
    expect(rows(sql)[0].state).toHaveLength(64 * 1024);
  });

  it('writes the offset and the state of ctx.upload.saved() in one SQL write', async () => {
    const queries: string[] = [];
    const { engine } = build({ onExec: (query) => queries.push(query) });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    await settle();

    queries.length = 0;
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    const writes = queries.filter((query) => query.includes('UPDATE __livething_uploads'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/saved_through = \?, state = \?/);
  });

  it('keeps no record and runs no onDiscard for a start whose size is over maxBytes', async () => {
    const { engine, discarded, sql } = build();
    const amara = await connect(engine);
    await amara.start('up-1', deck, 65);
    await settle();
    await engine.handleAlarm();

    await settle();

    expect(rows(sql)).toEqual([]);
    expect(discarded).toEqual([]);
  });

  it('runs onDiscard again only about a minute after it threw', async () => {
    const { engine, discarded } = build({ discardFailures: 1 });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    await settle();
    await amara.cancel('up-1');

    await settle();

    const realNow = Date.now;
    const at = realNow();
    try {
      Date.now = () => at + 30_000;
      await engine.handleAlarm();
      await settle();
      expect(discarded).toEqual([]);

      Date.now = () => at + 61_000;
      await engine.handleAlarm();
      await settle();
      expect(discarded).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("purgeUser runs onDiscard for the user's uploads that are not done, and deletes the done ones", async () => {
    const { engine, discarded, sql } = build();
    const amara = await connect(engine);
    await amara.start('up-done', deck);
    amara.piece('up-done', 1, piece(8, 1));
    await amara.end('up-done', 8);

    await amara.start('up-dropped', deck);
    amara.piece('up-dropped', 1, piece(8, 2));
    await settle();
    await amara.close();
    await settle();

    await (engine.admin() as any).purgeUser('u_amara');
    await engine.handleAlarm();
    await settle();

    expect(discarded).toEqual([{ input: deck, savedThrough: 8, state: { parts: 1 } }]);
    expect(rows(sql)).toEqual([]);
  });

  it('keeps size NULL with no size at the start, and moves updated_at when a dropped run ends', async () => {
    const { engine, sql } = build({ saveEvery: false });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    await settle();
    const startedAt = rows(sql)[0].updated_at;

    expect(rows(sql)[0].size).toBeNull();

    const realNow = Date.now;
    try {
      Date.now = () => startedAt + 30_000;
      await amara.close();
      await settle();
      expect(rows(sql)[0].updated_at).toBe(startedAt + 30_000);
    } finally {
      Date.now = realNow;
    }
  });

  it('logs a run that ignores its signal for 10 s, and ignores what it does later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const lateRunLogs: string[] = [];
      let wake!: () => void;
      const { engine, discarded, probeErrors } = build({
        hang: new Promise((resolve) => (wake = resolve)),
        logger: {
          info() {},
          warn() {},
          error(message) {
            if (String(message).includes('did not stop within 10 s')) {
              lateRunLogs.push(String(message));
            }
          },
        },
      });
      const amara = await connect(engine);

      await amara.start('up-1', deck);
      amara.piece('up-1', 1, piece(8, 1));
      await vi.advanceTimersByTimeAsync(10);

      const cancelling = amara.cancel('up-1');
      await vi.advanceTimersByTimeAsync(9_000);
      expect(lateRunLogs).toEqual([]);

      await vi.advanceTimersByTimeAsync(2_000);
      await cancelling;
      expect(lateRunLogs).toHaveLength(1);
      expect(discarded).toHaveLength(1);
      const framesBefore = amara.frames().length;

      wake();
      await vi.advanceTimersByTimeAsync(10);
      expect(probeErrors).toEqual(['upload-aborted']);
      expect(amara.frames()).toHaveLength(framesBefore);
      expect(discarded).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('base.binary.upload: the state schema', () => {
  const partsState = v.pipe(
    v.object({ parts: v.number() }),
    v.transform((state) => ({ ...state, checked: true })),
  );

  function warnings() {
    const warned: unknown[][] = [];
    const logger = { info() {}, warn: (...args: unknown[]) => warned.push(args), error() {} };

    return { warned, logger };
  }

  it('stores the state as given, and gives a resume and onDiscard the checked state', async () => {
    const { engine, runs, discarded, sql } = build({ state: partsState });
    const first = await connect(engine);
    await first.start('up-1', deck);
    first.piece('up-1', 1, piece(8, 1));
    await settle();

    expect(rows(sql)[0].state).toBe(JSON.stringify({ parts: 1 }));

    await first.close();
    await settle();
    const second = await connect(engine);
    await second.start('up-1', deck);
    await settle();

    await second.cancel('up-1');
    await settle();

    expect(runs.map((run) => run.state)).toEqual([undefined, { parts: 1, checked: true }]);
    expect(discarded).toEqual([
      { input: deck, savedThrough: 8, state: { parts: 1, checked: true } },
    ]);
  });

  it("ends a resume with 'bad-state' when the stored state fails a newer schema", async () => {
    const sql = createTestSql();
    const before = build({ sql });
    const amara = await connect(before.engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));

    await settle();
    await amara.close();
    await settle();

    // A deploy changed the schema: `{ parts: 1 }` no longer passes it.
    const { warned, logger } = warnings();
    const after = build({ sql, logger, state: v.object({ uploadId: v.string() }) });
    const again = await connect(after.engine);
    await again.start('up-1', deck);
    await settle();

    expect(after.runs).toEqual([]);
    expect(again.of('up-1')).toEqual([
      [
        '__error__',
        { code: 'upload-aborted', detail: { reason: 'bad-state' } },
        { upload: { id: 'up-1' } },
      ],
    ]);
    expect(after.discarded).toEqual([{ input: deck, savedThrough: 8, state: undefined }]);
    expect(rows(sql)).toEqual([]);
    expect(warned).toEqual([
      [
        expect.stringContaining("binary.upload('upload-attachment'): the stored state"),
        { event: 'upload-attachment', uploadId: 'up-1', issues: [expect.any(String)] },
      ],
    ]);
  });

  it('gives onDiscard an undefined state, and warns, when an expired upload has a bad state', async () => {
    const sql = createTestSql();
    const before = build({ sql, uploads: { expireAfterMs: 20 } });
    const amara = await connect(before.engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));

    await settle();
    await amara.close();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { warned, logger } = warnings();
    const after = build({
      sql,
      logger,
      state: v.object({ uploadId: v.string() }),
      uploads: { expireAfterMs: 20 },
    });
    await after.engine.initialize();
    await settle();

    expect(after.discarded).toEqual([{ input: deck, savedThrough: 8, state: undefined }]);
    expect(rows(sql)).toEqual([]);
    expect(warned).toEqual([
      [
        expect.stringContaining("binary.upload('upload-attachment'): the stored state"),
        { event: 'upload-attachment', uploadId: 'up-1', issues: [expect.any(String)] },
      ],
    ]);
  });

  it('throws a TypeError from saved() with a state when the handler has no state schema', async () => {
    const thrown: string[] = [];
    const { engine } = build({
      state: null,
      afterRead(upload) {
        try {
          upload.saved(8, { state: { parts: 1 } });
        } catch (error) {
          thrown.push(`${(error as Error).name}: ${(error as Error).message}`);
        }
      },
    });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));

    await settle();

    expect(thrown).toEqual([
      "TypeError: [livething] ctx.upload.saved(): binary.upload('upload-attachment') declares no 'state' schema, so it keeps no state. Add a 'state' schema to the handler.",
    ]);
  });
});

describe('base.binary.upload: reading the state back', () => {
  /** An upload with 8 saved bytes and a state, whose connection dropped. */
  async function droppedUpload(sql: ReturnType<typeof createTestSql>) {
    const before = build({ sql });
    const amara = await connect(before.engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    await amara.close();
    await settle();
  }

  function aborted(reason: string) {
    return [
      '__error__',
      { code: 'upload-aborted', detail: { reason } },
      { upload: { id: 'up-1' } },
    ];
  }

  it('refuses both starts from one connection when its cancel comes while an intercept holds them', async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const after = build({ sql, slowStartMs: 200 });
    const amara = await connect(after.engine);

    const first = amara.start('up-1', deck);
    const second = amara.start('up-1', deck);
    await settle();
    await amara.cancel('up-1');
    await Promise.all([first, second]);

    await settle();

    expect(after.runs).toEqual([]);
    expect(rows(sql)).toEqual([]);
    expect(amara.of('up-1')).toEqual([aborted('cancelled'), aborted('cancelled')]);
    expect(after.discarded).toHaveLength(1);
  });

  it('refuses an async state schema with a clear error, and keeps the record', async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const asyncState = v.pipeAsync(
      v.object({ parts: v.number() }),
      v.checkAsync(async () => true),
    );
    const after = build({ sql, state: asyncState });
    const again = await connect(after.engine);

    await again.start('up-1', deck);
    await settle();

    // A config error, not bad data: the app's onError gets it, and the upload is not touched.
    expect(after.hookErrors.join('\n')).toContain(
      "binary.upload('upload-attachment'): the 'state' schema must be synchronous",
    );
    expect(again.of('up-1').some((frame) => frame[0] === '__uploadAck__')).toBe(false);
    expect(after.runs).toEqual([]);
    expect(after.discarded).toEqual([]);
    expect(rows(sql)).toMatchObject([{ status: 'active', state: JSON.stringify({ parts: 1 }) }]);
  });

  it('finishes the expiry sweep at server start with an async state schema, keeping the record', async () => {
    const sql = createTestSql();
    const before = build({ sql, uploads: { expireAfterMs: 20 } });
    const amara = await connect(before.engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));

    await settle();
    await amara.close();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logged: unknown[][] = [];
    const logger = { info() {}, warn() {}, error: (...args: unknown[]) => logged.push(args) };
    const asyncState = v.pipeAsync(
      v.unknown(),
      v.checkAsync(async () => true),
    );
    const after = build({ sql, logger, state: asyncState, uploads: { expireAfterMs: 20 } });
    await after.engine.initialize();

    await settle();

    expect(after.discarded).toEqual([]);
    // The sweep marked the record before it read the state: it waits, and is tried again.
    expect(rows(sql)).toMatchObject([{ status: 'discarding' }]);
    expect(logged).toEqual([
      [
        expect.stringContaining(
          "the 'state' schema of binary.upload('upload-attachment') is async",
        ),
        {
          event: 'upload-attachment',
          uploadId: 'up-1',
          error: expect.stringContaining("the 'state' schema must be synchronous"),
        },
      ],
    ]);
  });

  it('refuses a state schema that returns a thenable, and keeps the record', async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const thenableState = {
      '~standard': {
        version: 1 as const,
        vendor: 'huddle-test',
        validate: () => ({ then: (resolve: (result: unknown) => void) => resolve({ value: 1 }) }),
      },
    };

    const after = build({ sql, state: thenableState as never });
    const again = await connect(after.engine);

    await again.start('up-1', deck);
    await settle();

    expect(after.hookErrors.join('\n')).toContain("the 'state' schema must be synchronous");
    expect(after.runs).toEqual([]);
    expect(rows(sql)).toMatchObject([{ status: 'active', state: JSON.stringify({ parts: 1 }) }]);
  });

  it('runs a start that comes after the cancel, while an older start is still held', async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const after = build({ sql, slowStartMs: 200 });
    const amara = await connect(after.engine);

    const first = amara.start('up-1', deck);
    await settle();
    await amara.cancel('up-1');
    const second = amara.start('up-1', deck);
    await Promise.all([first, second]);

    await settle();

    expect(amara.of('up-1')[0]).toEqual(aborted('cancelled'));
    expect(after.runs).toMatchObject([{ savedThrough: 0 }]);
  });

  it('refuses only the held start, when a start sent after the cancel overtakes it', async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const after = build({ sql, startDelays: [80, 0] });
    const amara = await connect(after.engine);

    const brief = { attachmentId: 'att_brief' };
    const first = amara.start('up-1', deck);
    await settle();
    await amara.cancel('up-1');
    const second = amara.start('up-1', brief);

    await Promise.all([first, second]);
    await settle();

    // The second start ran a new upload; the first one, sent before the cancel, refuses
    // without touching it.
    expect(after.runs).toMatchObject([{ savedThrough: 0 }]);
    expect(rows(sql)).toMatchObject([{ input: JSON.stringify(brief), status: 'active' }]);
    const refused = amara.of('up-1').filter((frame) => frame[0] === '__error__');
    expect(refused).toEqual([aborted('cancelled')]);

    amara.piece('up-1', 1, piece(8, 1));
    await amara.end('up-1', 8);
    await settle();
    expect(after.runs.map((run) => run.ended)).toEqual(['done']);
    expect(amara.of('up-1').at(-1)).toEqual([
      '__uploadDone__',
      { info: { size: 8 } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it('marks no held start for a cancel sent as a binary frame', async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const after = build({ sql, slowStartMs: 200 });
    const amara = await connect(after.engine);

    const first = amara.start('up-1', deck);
    await settle();
    await amara.sendBinary(['__uploadCancel__', null, { upload: { id: 'up-1' } }]);
    await first;
    await settle();

    expect(after.runs).toMatchObject([{ savedThrough: 8 }]);
  });

  it.each([
    ['no result object', undefined],
    ['issues that are not an array', { issues: 'nope' }],
    ['an issue that is not an object', { issues: [null] }],
  ])("gives 'bad-state' when a state schema's validate returns %s", async (_, returned) => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const brokenState = {
      '~standard': { version: 1 as const, vendor: 'huddle-test', validate: () => returned },
    };

    const after = build({ sql, state: brokenState as never });
    const again = await connect(after.engine);

    await again.start('up-1', deck);
    await settle();

    expect(again.of('up-1')).toEqual([aborted('bad-state')]);
    expect(after.discarded).toEqual([{ input: deck, savedThrough: 8, state: undefined }]);
  });

  /** Call `saved(8, { state })` after the first piece; return what it threw and the stored row. */
  async function saveState(state: unknown, schema: v.GenericSchema | v.GenericSchemaAsync) {
    const thrown: string[] = [];
    const { engine, sql } = build({
      state: schema,
      saveEvery: false,
      afterRead(upload) {
        try {
          upload.saved(8, { state });
        } catch (error) {
          thrown.push(`${(error as Error).name}: ${(error as Error).message}`);
        }
      },
    });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));

    await settle();

    return { thrown, row: rows(sql)[0] };
  }

  it.each([
    ['a Date', v.object({ at: v.date() }), { at: new Date(0) }],
    ['a Map', v.object({ tags: v.map(v.string(), v.string()) }), { tags: new Map([['a', 'b']]) }],
    ['NaN', v.object({ ratio: v.number() }), { ratio: Number.NaN }],
  ])(
    'throws from saved() for a state with %s that would fail the schema after JSON',
    async (_, schema, state) => {
      const { thrown, row } = await saveState(state, schema);

      expect(thrown).toEqual([
        expect.stringMatching(
          /^TypeError: \[livething\] ctx\.upload\.saved\(\): binary\.upload\('upload-attachment'\): the state fails the 'state' schema in its JSON form/,
        ),
      ]);
      expect(row).toMatchObject({ saved_through: 0, state: null });
    },
  );

  it('throws a clear TypeError from saved() for a state that has no JSON form', async () => {
    const { thrown, row } = await saveState(() => 'att_1', v.unknown());

    expect(thrown).toEqual([
      "TypeError: [livething] ctx.upload.saved(): binary.upload('upload-attachment'): the state has no JSON form, so it cannot be stored.",
    ]);
    expect(row.state).toBeNull();
  });

  it('throws the async-schema error from saved() for an async state schema', async () => {
    const { thrown } = await saveState(
      { parts: 1 },
      v.pipeAsync(
        v.unknown(),
        v.checkAsync(async () => true),
      ),
    );

    expect(thrown).toEqual([
      expect.stringContaining(
        "LiveThingConfigError: [livething] binary.upload('upload-attachment'): the 'state' schema must be synchronous",
      ),
    ]);
  });

  it('marks no held start for a cancel frame that fails its shape check', async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const after = build({ sql, slowStartMs: 200 });
    const amara = await connect(after.engine);

    const first = amara.start('up-1', deck);
    await settle();
    // A payload must be `null`.
    await amara.sendText(['__uploadCancel__', { now: true }, { upload: { id: 'up-1' } }]);
    await first;
    await settle();

    expect(after.runs).toMatchObject([{ savedThrough: 8 }]);
  });

  it("gives 'bad-state' when a sync state schema throws a LiveThingConfigError", async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const configThrowingState = {
      '~standard': {
        version: 1 as const,
        vendor: 'huddle-test',
        validate(): never {
          throw new LiveThingConfigError('the schema is set up wrong');
        },
      },
    };

    const after = build({ sql, state: configThrowingState as never });
    const again = await connect(after.engine);

    await again.start('up-1', deck);
    await settle();

    expect(again.of('up-1')).toEqual([aborted('bad-state')]);
    expect(after.discarded).toEqual([{ input: deck, savedThrough: 8, state: undefined }]);
  });

  it('refuses both held starts when the cancel comes after both, whatever order they finish in', async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const after = build({ sql, startDelays: [80, 30] });
    const amara = await connect(after.engine);

    const first = amara.start('up-1', deck);
    const second = amara.start('up-1', deck);
    await settle();
    await amara.cancel('up-1');
    await Promise.all([first, second]);

    await settle();

    expect(after.runs).toEqual([]);
    expect(amara.of('up-1')).toEqual([aborted('cancelled'), aborted('cancelled')]);
  });

  it('runs a start sent after the cancel when an older held start fails its input check', async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const after = build({ sql, startDelays: [80, 0] });
    const amara = await connect(after.engine);

    const first = amara.start('up-1', { attachmentId: 42 });
    await settle();
    await amara.cancel('up-1');
    const second = amara.start('up-1', deck);
    await Promise.all([first, second]);

    await settle();

    expect(after.runs).toMatchObject([{ savedThrough: 0 }]);
    const codes = amara
      .of('up-1')
      .flatMap((frame) => (frame[0] === '__error__' ? [frame[1].code] : []));
    expect(codes).toEqual(['validation-failed']);
  });

  it('refuses a state option that is not a Standard Schema, when the handler is defined', () => {
    const base = server({ capabilities: [binary(), uploads()] });

    expect(() =>
      base.binary.upload('upload-attachment', {
        state: ((value: unknown) => value) as never,
        run: async () => ({ info: null }),
      }),
    ).toThrow(LiveThingConfigError);
    expect(() =>
      base.binary.upload('upload-attachment', {
        state: ((value: unknown) => value) as never,
        run: async () => ({ info: null }),
      }),
    ).toThrow("base.binary.upload('upload-attachment'): 'state' must be a Standard Schema");
  });

  it('runs a start sent in the same tick right after the cancel', async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const after = build({ sql });
    const amara = await connect(after.engine);

    void amara.cancel('up-1');
    await amara.start('up-1', deck);
    await settle();

    expect(after.runs).toMatchObject([{ savedThrough: 0 }]);
    expect(amara.of('up-1').filter((frame) => frame[0] === '__error__')).toEqual([]);
  });

  it("logs a LiveThingConfigError from the app's onDiscard as an onDiscard error", async () => {
    const logged: unknown[][] = [];
    const logger = { info() {}, warn() {}, error: (...args: unknown[]) => logged.push(args) };
    const { engine } = build({
      logger,
      discardFailures: 1,
      discardError: new LiveThingConfigError('the bucket is not set up'),
    });
    const amara = await connect(engine);
    await amara.start('up-1', deck);

    amara.piece('up-1', 1, piece(8, 1));
    await settle();
    await amara.cancel('up-1');
    await settle();

    expect(logged).toEqual([
      [
        '[livething] an upload onDiscard threw. It runs again on the next sweep.',
        {
          event: 'upload-attachment',
          uploadId: 'up-1',
          error: '[livething] the bucket is not set up',
        },
      ],
    ]);
  });

  it('runs and discards an upload with no state schema as before', async () => {
    const { engine, runs, discarded, sql } = build({ state: null });
    const first = await connect(engine);
    await first.start('up-1', deck);
    first.piece('up-1', 1, piece(8, 1));
    await settle();

    expect(rows(sql)[0].state).toBeNull();
    await first.close();
    await settle();

    const second = await connect(engine);
    await second.start('up-1', deck);
    await settle();
    await second.cancel('up-1');
    await settle();

    expect(runs.map((run) => [run.savedThrough, run.state])).toEqual([
      [0, undefined],
      [8, undefined],
    ]);
    expect(discarded).toEqual([{ input: deck, savedThrough: 8, state: undefined }]);
  });

  it('keeps no state for saved(n, { state: undefined }), so an optional schema resumes', async () => {
    const { engine, runs, sql } = build({
      state: v.optional(v.object({ parts: v.number() })),
      afterRead: (upload) => upload.saved(8, { state: undefined }),
    });
    const amara = await connect(engine);
    await amara.start('up-1', deck);
    amara.piece('up-1', 1, piece(8, 1));
    await settle();

    expect(rows(sql)[0].state).toBeNull();

    await amara.close();
    await settle();
    const again = await connect(engine);
    await again.start('up-1', deck);
    await settle();

    expect(runs[1]).toMatchObject({ savedThrough: 8, state: undefined });
  });

  /** A state schema whose check throws instead of returning issues. */
  const throwingState = {
    '~standard': {
      version: 1 as const,
      vendor: 'huddle-test',
      validate(): never {
        throw new Error('the schema broke');
      },
    },
  };

  it("ends a resume with 'bad-state' when the state schema throws", async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const warned: unknown[][] = [];
    const logger = { info() {}, warn: (...args: unknown[]) => warned.push(args), error() {} };
    const after = build({ sql, logger, state: throwingState as never });

    const again = await connect(after.engine);
    await again.start('up-1', deck);
    await settle();

    expect(after.runs).toEqual([]);
    expect(again.of('up-1')).toEqual([aborted('bad-state')]);
    expect(after.discarded).toEqual([{ input: deck, savedThrough: 8, state: undefined }]);
    expect(rows(sql)).toEqual([]);
    expect(warned).toEqual([
      [
        expect.stringContaining('the stored state'),
        { event: 'upload-attachment', uploadId: 'up-1', issues: ['the schema broke'] },
      ],
    ]);
  });

  it('gives onDiscard an undefined state when the state schema throws', async () => {
    const sql = createTestSql();
    await droppedUpload(sql);
    const after = build({ sql, state: throwingState as never });
    const again = await connect(after.engine);
    await again.start('up-1', deck).catch(() => {});

    await settle();
    // The start above already discarded it; a cancel of a live upload goes the same way.
    expect(after.discarded).toEqual([{ input: deck, savedThrough: 8, state: undefined }]);

    const sql2 = createTestSql();
    await droppedUpload(sql2);
    const expired = build({ sql: sql2, state: throwingState as never });
    const amara = await connect(expired.engine);
    await amara.cancel('up-1');

    await settle();
    expect(expired.discarded).toEqual([{ input: deck, savedThrough: 8, state: undefined }]);
    expect(rows(sql2)).toEqual([]);
  });
});
