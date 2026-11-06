/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { encodeBinaryFrame, LiveThingConfigError, splitBinaryFrame } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { binary } from '~/binary/capability.ts';
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
  /** `run` waits for this before it reads each piece. */
  readGate?: Promise<void>;
  /** Runs with `ctx.upload` after each piece `run` reads; what it throws is recorded. */
  afterRead?: (upload: any) => void;
  /** What `run` returns instead of `{ info: { size } }`. */
  reply?: unknown;
  /**
   * After its first piece, the first `run` waits for this and ignores its signal. Then it calls
   * `saved()` once more, and what that throws is recorded.
   */
  hang?: Promise<void>;
  /** The intercept holds each upload start this long, as an async check would. */
  slowStartMs?: number;
  /** The server's global rate limit. Default: so high that no test reaches it. */
  rateLimit?: RateLimitGlobalConfig;
  /** The upload handler's own rate limit. */
  uploadRateLimit?: RateLimitConfig;
  /** Sees every SQL statement; a throw fails that statement. */
  onExec?: (query: string) => void;
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
            ctx.upload.saved(size, { state: { parts: run.offsets.length } });
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
        throw error;
      }

      run.ended = 'done';

      return (options.reply ?? { info: { size } }) as never;
    },
    onDiscard(ctx, input) {
      if (discardFailures > 0) {
        discardFailures -= 1;
        throw new Error('the storage is down');
      }

      discarded.push({ input, savedThrough: ctx.upload.savedThrough, state: ctx.upload.state });
    },
  });
  const watch = intercept(async (_ctx, frame) => {
    kinds.push(`${frame.event}:${frame.kind}`);
    if (options.slowStartMs)
      await new Promise((resolve) => setTimeout(resolve, options.slowStartMs));

    return frame.payload;
  });
  const definition = base.assemble({ handlers: [handleUploadAttachment, watch as never] });

  let engine!: Engine;
  const timers = createTestTimers();
  adapter({
    id: 'upload-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: {
          sql: createTestSql(options.onExec ? { onExec: options.onExec } : {}),
          kv: createTestKV(),
        },
        timers,
        platform: {},
        logger: { info() {}, warn() {}, error() {} },
        ...(options.messageLimits ? { messageLimits: options.messageLimits } : {}),
      });
      return {};
    },
  })(definition, undefined as never);

  return { engine, runs, discarded, kinds, hookErrors, probeErrors, timers };
}

async function connect(engine: Engine, userId = 'u_amara') {
  await engine.initialize();
  const sent: TransportFrame[] = [];
  const handle = engine.accept(Symbol(userId), {
    send: (data: TransportFrame) => {
      sent.push(data);
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
    /** Send piece 1 of `up-1` under another event name. */
    pieceAs: (event: string, bytes: Uint8Array) =>
      handle.handleBinaryMessage(
        encodeBinaryFrame(JSON.stringify([event, null, { upload: { id: 'up-1', seq: 1 } }]), bytes),
      ),
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
    const { engine, runs, discarded } = build({ slowStartMs: 30 });
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
    const { engine, runs, discarded } = build({ slowStartMs: 30 });
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
