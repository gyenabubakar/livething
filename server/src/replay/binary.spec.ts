import { AsyncLocalStorage } from 'node:async_hooks';
import { splitBinaryFrame } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import * as ReplayRuntime from '~/replay/runtime.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { sequence } from '~/sequence/capability.ts';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineRuntimeOptions, TransportFrame } from '~/_adapters/types.ts';
import type { HostCapability } from '~/_define/capability.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { SqlLimits } from '~/context.ts';

const general = { channel: { name: 'room:general', family: 'rooms' } };

/** A picture of `size` bytes whose values tell the pictures apart. */
function picture(size: number, mark: number): Uint8Array {
  return new Uint8Array(size).fill(mark);
}

interface Built {
  engine: Engine;
  warnings: unknown[][];
  sql: ReturnType<typeof createTestSql>;
  /** What each send in `resend-wrong-kind` returned or threw. */
  sendReplayErrors: string[];
  /** How each `confirm-avatar` server request ended: its answer, or its error code. */
  requestResults: unknown[];
}

interface BuildOptions {
  limits?: Partial<SqlLimits>;
  messageLimits?: EngineRuntimeOptions['messageLimits'];
}

function build(replayCapability: HostCapability<{}, 'replay'>, options: BuildOptions = {}): Built {
  const warnings: unknown[][] = [];
  const sendReplayErrors: string[] = [];
  const requestResults: unknown[] = [];
  const sql = createTestSql(options.limits ? { limits: options.limits } : {});
  const base = server({
    capabilities: [
      binary({ emits: { 'avatar-preview': t<{ userId: string }>() } }),
      emits({ 'avatar-saved': t<{ userId: string; text: string }>() }),
      serverRequests({
        'confirm-avatar': { out: t<{ userId: string }>(), in: v.object({ ok: v.boolean() }) },
      }),
      channels(),
      dedup(),
      sequence({ persist: true }),
      replayCapability,
    ],
  });
  // Asks the caller to confirm its new avatar, and waits 200 ms at most.
  const changeAvatar = base.on('change-avatar', {
    run(ctx) {
      ctx.request('confirm-avatar', { userId: ctx.user.id }, { timeout: 200 }).then(
        (answer) => requestResults.push(answer),
        (error: unknown) => requestResults.push((error as { code?: string }).code),
      );
    },
  });
  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    capabilities: [
      binary({ emits: { 'screen-frame': t<{ from: string }>() } }),
      emits({ 'screen-share-started': t<{ from: string }>() }),
    ],
  });

  const previewAvatar = base.on('preview-avatar', {
    input: v.object({ size: v.number(), mark: v.number() }),
    run(ctx, input) {
      ctx.binary.broadcast(
        'avatar-preview',
        { userId: ctx.user.id },
        picture(input.size, input.mark),
        {
          includeSelf: true,
        },
      );
    },
  });

  const previewAvatarForMe = base.on('preview-avatar-for-me', {
    input: v.object({ size: v.number(), mark: v.number() }),
    run(ctx, input) {
      ctx.user.binary.broadcast(
        'avatar-preview',
        { userId: ctx.user.id },
        picture(input.size, input.mark),
      );
    },
  });
  // Sends the picture, then reuses its buffer for the next one, as a camera loop does.
  const previewThenReuseBuffer = base.on('preview-then-reuse-buffer', {
    run(ctx) {
      const buffer = picture(4, 1);
      ctx.binary.broadcast('avatar-preview', { userId: ctx.user.id }, buffer, {
        includeSelf: true,
      });
      buffer.fill(2);
    },
  });
  const saveAvatar = base.on('save-avatar', {
    input: v.object({ text: v.string() }),
    run(ctx, input) {
      ctx.broadcast(
        'avatar-saved',
        { userId: ctx.user.id, text: input.text },
        { includeSelf: true },
      );
    },
  });
  const shareScreen = rooms.on('share-screen', {
    input: v.object({ frames: v.number() }),
    run(ctx, input) {
      ctx.channel.broadcast('screen-share-started', { from: ctx.user.id });
      for (let mark = 1; mark <= input.frames; mark += 1) {
        ctx.channel.binary.broadcast('screen-frame', { from: ctx.user.id }, picture(100, mark), {
          includeSelf: true,
        });
      }
    },
  });
  // Send one stored picture again, to the caller only, with the wire it had.
  const ResendInput = v.object({ deliverySeq: v.number(), messageId: v.string() });
  const resendAvatarPreview = base.on('resend-avatar-preview', {
    input: ResendInput,
    run(ctx, wire) {
      ctx.binary.sendReplay('avatar-preview', { userId: ctx.user.id }, picture(3, 4), wire);
      ctx.binary.sendReplay('screen-frame', { from: ctx.user.id }, picture(2, 5), {
        ...wire,
        channel: rooms.at({ roomId: 'general' }),
      });
    },
  });
  const resendScreenFrame = rooms.on('resend-screen-frame', {
    input: ResendInput,
    run(ctx, wire) {
      ctx.channel.binary.sendReplay?.('screen-frame', { from: ctx.user.id }, picture(2, 6), wire);
    },
  });
  const resendWrongKind = base.on('resend-wrong-kind', {
    run(ctx) {
      const wire = { deliverySeq: 1, messageId: 'm-1' };
      for (const resend of [
        () => ctx.sendReplay('avatar-preview' as never, { userId: 'u' } as never, wire),
        () => ctx.binary.sendReplay('avatar-saved' as never, null as never, picture(1, 1), wire),
      ]) {
        try {
          resend();
          sendReplayErrors.push('sent');
        } catch (error) {
          sendReplayErrors.push((error as Error).message);
        }
      }
    },
  });
  const definition = base.assemble({
    handlers: [
      previewAvatar,
      previewAvatarForMe,
      saveAvatar,
      rooms,
      shareScreen,
      resendAvatarPreview,
      resendScreenFrame,
      resendWrongKind,
      changeAvatar,
      previewThenReuseBuffer,
    ],
  });

  let engine!: Engine;
  adapter({
    id: 'replay-binary-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql, kv: createTestKV() },
        timers: createTestTimers(),
        platform: {},
        logger: {
          info: vi.fn(),
          warn: (...args: unknown[]) => warnings.push(args),
          error: vi.fn(),
        },
        ...(options.messageLimits ? { messageLimits: options.messageLimits } : {}),
      });
      return {};
    },
  })(definition, undefined as never);

  return { engine, warnings, sql, sendReplayErrors, requestResults };
}

interface Member {
  sent: TransportFrame[];
  /** The close codes the server closed this socket with. */
  closes: (number | 'terminated' | undefined)[];
  /** What the socket reports as buffered, and a hook that runs after each frame is written. */
  buffered: { bytes: number; afterSend?: () => void };
  /** Every frame in order: a binary frame as its envelope and bytes, a text frame as JSON. */
  frames: () => { envelope: unknown[]; bytes?: number[] }[];
  send: (event: string, payload?: unknown, metadata?: unknown) => Promise<void>;
  close: () => Promise<void>;
  /** Send one raw text message, such as a heartbeat. */
  sendText: (text: string) => Promise<void>;
  /** The seq the server gave this connection to catch up from. */
  resumeSeq: () => number;
}

async function connect(
  engine: Engine,
  userId: string,
  backpressureSupported = false,
): Promise<Member> {
  await engine.initialize();
  const sent: TransportFrame[] = [];
  const buffered: Member['buffered'] = { bytes: 0 };
  const closes: Member['closes'] = [];
  const handle = engine.accept(Symbol(userId), {
    send: (data: TransportFrame) => {
      sent.push(data);
      buffered.afterSend?.();
    },
    close: (code?: number) => closes.push(code),
    terminate: () => closes.push('terminated'),
    bufferedAmount: () => buffered.bytes,
    backpressureSupported,
    userId,
  });

  await [...engine.core.connections.values()].at(-1)!.lifecycleReady;

  function frames() {
    return sent.map((data) => {
      if (data.kind === 'text' && data.text === 'pong') return { envelope: ['__pong__'] };

      if (data.kind === 'text') return { envelope: JSON.parse(data.text) as unknown[] };

      const split = splitBinaryFrame(data.bytes);
      if (split.kind !== 'frame') throw new Error(`not a LiveThing frame: ${split.kind}`);

      return { envelope: JSON.parse(split.envelope) as unknown[], bytes: [...split.bytes] };
    });
  }

  return {
    sent,
    closes,
    buffered,
    frames,
    send: (event, payload = null, metadata = null) =>
      handle.handleMessage(JSON.stringify([event, payload, metadata])),
    close: () => handle.handleClose(1000, 'bye'),
    sendText: (text) => handle.handleMessage(text),
    resumeSeq: () => {
      const resume = frames().find((frame) => frame.envelope[0] === '__resume__');
      return (resume!.envelope[1] as { seq: number }).seq;
    },
  };
}

/** The user frames a connection got, without the protocol frames. */
function userFrames(member: Member) {
  return member.frames().filter((frame) => !String(frame.envelope[0]).startsWith('__'));
}

function seqOf(frame: { envelope: unknown[] }): number {
  return (frame.envelope[2] as { delivery: { seq: number } }).delivery.seq;
}

describe('replay stores binary events', () => {
  it('sends a missed binary event back as one binary frame, with the bytes and metadata of the live send', async () => {
    const { engine } = build(replay.history());
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');
    const since = kofi.resumeSeq();
    await kofi.close();

    await amara.send('preview-avatar', { size: 3, mark: 7 });
    const kofiAgain = await connect(engine, 'u_kofi');
    await kofiAgain.send('__replay__', { lastKnownSeq: since });

    const [live] = userFrames(amara);
    const [replayed] = userFrames(kofiAgain);
    expect(kofiAgain.sent.filter((frame) => frame.kind === 'bytes')).toHaveLength(1);
    expect(replayed).toEqual(live);
    expect(replayed!.bytes).toEqual([7, 7, 7]);

    expect(replayed!.envelope).toEqual([
      'avatar-preview',
      { userId: 'u_amara' },
      { delivery: { id: expect.any(String), seq: expect.any(Number) } },
    ]);
  });

  it('keeps the channel metadata of a channel binary broadcast', async () => {
    const { engine } = build(replay.history());
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');
    await amara.send('__subscribe__', {}, general);
    await kofi.send('__subscribe__', {}, general);

    const subscribed = kofi.frames().find((frame) => frame.envelope[0] === '__subscribeOk__');
    const since = (subscribed!.envelope[1] as { seq: number }).seq;
    await kofi.close();

    await amara.send('share-screen', { frames: 2 }, general);
    const kofiAgain = await connect(engine, 'u_kofi');
    await kofiAgain.send('__subscribe__', {}, general);
    await kofiAgain.send('__replay__', { lastKnownSeq: since }, general);

    // The sender does not get its own screen-share-started, so it heard only the frames.
    expect(userFrames(kofiAgain).slice(1)).toEqual(userFrames(amara));
    expect(userFrames(kofiAgain).map((frame) => frame.envelope[0])).toEqual([
      'screen-share-started',
      'screen-frame',
      'screen-frame',
    ]);
    expect(userFrames(kofiAgain)[1]!.envelope[2]).toMatchObject(general);
    expect(userFrames(kofiAgain).map((frame) => frame.bytes?.[0])).toEqual([undefined, 1, 2]);
  });

  it('sends JSON and binary rows strictly in seq order', async () => {
    const { engine } = build(replay.history());
    const amara = await connect(engine, 'u_amara');
    const since = amara.resumeSeq();

    await amara.send('save-avatar', { text: 'first' });
    await amara.send('preview-avatar', { size: 2, mark: 1 });
    await amara.send('save-avatar', { text: 'second' });
    await amara.send('preview-avatar', { size: 2, mark: 2 });
    const live = userFrames(amara);

    await amara.close();

    const amaraAgain = await connect(engine, 'u_amara');
    await amaraAgain.send('__replay__', { lastKnownSeq: since });

    const replayed = userFrames(amaraAgain);
    expect(replayed.map((frame) => frame.envelope[0])).toEqual([
      'avatar-saved',
      'avatar-preview',
      'avatar-saved',
      'avatar-preview',
    ]);
    expect(replayed).toEqual(live);
    const seqs = replayed.map(seqOf);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('skips a binary event listed in exclude', async () => {
    const { engine, sql } = build(replay.history({ exclude: ['avatar-preview'] }));
    const amara = await connect(engine, 'u_amara');

    await amara.send('preview-avatar', { size: 2, mark: 1 });
    await amara.send('save-avatar', { text: 'saved' });

    expect(
      sql
        .exec<{ event: string }>('SELECT event FROM __livething_replay')
        .toArray()
        .map((row) => row.event),
    ).toEqual(['avatar-saved']);
  });
});

describe('retention.maxBytes', () => {
  it('deletes the oldest rows past maxBytes, raises the watermark and sends __gap__', async () => {
    // Each row is its info JSON plus its bytes: 20 bytes of info and 1000 bytes of picture.
    const { engine, sql } = build(replay.history({ retention: { maxBytes: 2500 } }));
    const amara = await connect(engine, 'u_amara');
    const since = amara.resumeSeq();

    await amara.send('preview-avatar', { size: 1000, mark: 1 });
    await amara.send('preview-avatar', { size: 1000, mark: 2 });
    await amara.send('preview-avatar', { size: 1000, mark: 3 });
    const live = userFrames(amara);
    await amara.close();

    expect(
      sql
        .exec<{ seq: number }>('SELECT seq FROM __livething_replay ORDER BY seq')
        .toArray()
        .map((row) => Number(row.seq)),
    ).toEqual(live.slice(1).map(seqOf));

    const amaraAgain = await connect(engine, 'u_amara');
    await amaraAgain.send('__replay__', { lastKnownSeq: since });

    const [gap] = amaraAgain.frames().filter((frame) => frame.envelope[0] === '__gap__');
    expect(gap!.envelope[1]).toEqual({ missedThrough: seqOf(live[0]!) });
    expect(userFrames(amaraAgain).map((frame) => frame.bytes?.[0])).toEqual([2, 3]);
  });

  it('counts JSON rows by the UTF-8 bytes of their payload', async () => {
    const { engine, sql } = build(replay.history({ retention: { maxBytes: 300 } }));
    const amara = await connect(engine, 'u_amara');

    // `{"userId":"u_amara","text":"…"}` is 30 bytes plus the text; "é" is 2 bytes in UTF-8.
    await amara.send('save-avatar', { text: 'é'.repeat(50) });
    await amara.send('save-avatar', { text: 'é'.repeat(50) });
    await amara.send('save-avatar', { text: 'é'.repeat(50) });

    expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM __livething_replay').one()!.n).toBe(
      2,
    );
  });

  it('counts each audience on its own, so one user’s rows never push out the shared rows', async () => {
    const { engine, sql } = build(replay.history({ retention: { maxBytes: 2500 } }));
    const amara = await connect(engine, 'u_amara');

    await amara.send('preview-avatar', { size: 1000, mark: 1 });
    await amara.send('preview-avatar-for-me', { size: 1000, mark: 2 });
    await amara.send('preview-avatar-for-me', { size: 1000, mark: 3 });
    await amara.send('preview-avatar-for-me', { size: 1000, mark: 4 });

    const rows = sql
      .exec<{ audience: string }>('SELECT audience FROM __livething_replay ORDER BY seq')
      .toArray()
      .map((row) => row.audience);
    expect(rows).toEqual(['', 'user:u_amara', 'user:u_amara']);
  });

  it('defaults to 64 MiB', async () => {
    const { engine, sql } = build(replay.history());
    const amara = await connect(engine, 'u_amara');

    await amara.send('preview-avatar', { size: 30 * 1024 * 1024, mark: 1 });
    await amara.send('preview-avatar', { size: 30 * 1024 * 1024, mark: 2 });
    await amara.send('preview-avatar', { size: 10 * 1024 * 1024, mark: 3 });

    expect(
      sql
        .exec<{ seq: number }>('SELECT seq FROM __livething_replay')
        .toArray()
        .map((row) => Number(row.seq)),
    ).toEqual(userFrames(amara).slice(1).map(seqOf));
  }, 30_000);

  it('is checked like the other retention options', () => {
    expect(() => replay.history({ retention: { maxBytes: 0 } })).toThrow(/retention\.maxBytes/);
    expect(() => replay.history({ retention: { maxBytes: 1.5 } })).toThrow(/retention\.maxBytes/);
  });
});

describe('a row over the storage row limit', () => {
  it('is not stored, the live send still works, and LiveThing warns once per event', async () => {
    const { engine, sql, warnings } = build(replay.history(), { limits: { maxValueBytes: 2000 } });
    const amara = await connect(engine, 'u_amara');

    await amara.send('preview-avatar', { size: 3000, mark: 1 });
    await amara.send('preview-avatar', { size: 3000, mark: 2 });
    await amara.send('save-avatar', { text: 'x'.repeat(3000) });
    await amara.send('preview-avatar', { size: 10, mark: 3 });

    expect(userFrames(amara).map((frame) => frame.envelope[0])).toEqual([
      'avatar-preview',
      'avatar-preview',
      'avatar-saved',
      'avatar-preview',
    ]);
    expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM __livething_replay').one()!.n).toBe(
      1,
    );
    expect(warnings.map(([message]) => message)).toEqual([
      expect.stringMatching(/"avatar-preview" .*over the storage row limit of 2000 bytes/),
      expect.stringMatching(/"avatar-saved" .*over the storage row limit of 2000 bytes/),
    ]);
  });
});

describe('catch-up backpressure', () => {
  it('waits while the buffer is high, and sends live frames only after the catch-up', async () => {
    const { engine } = build(replay.history());
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');
    const since = kofi.resumeSeq();
    await kofi.close();

    await amara.send('preview-avatar', { size: 10, mark: 1 });
    await amara.send('preview-avatar', { size: 10, mark: 2 });
    await amara.send('preview-avatar', { size: 10, mark: 3 });

    const kofiAgain = await connect(engine, 'u_kofi', true);
    kofiAgain.buffered.bytes = 512 * 1024;
    const catchUp = kofiAgain.send('__replay__', { lastKnownSeq: since });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(userFrames(kofiAgain)).toEqual([]);
    await amara.send('save-avatar', { text: 'sent during the catch-up' });
    expect(userFrames(kofiAgain)).toEqual([]);
    // A heartbeat answer never waits, so the client does not think the connection is dead.
    await kofiAgain.sendText('ping');
    expect(kofiAgain.sent.at(-1)).toEqual({ kind: 'text', text: 'pong' });

    kofiAgain.buffered.bytes = 0;
    await catchUp;

    const frames = userFrames(kofiAgain);
    expect(frames.map((frame) => frame.envelope[0])).toEqual([
      'avatar-preview',
      'avatar-preview',
      'avatar-preview',
      'avatar-saved',
    ]);
    const seqs = frames.map(seqOf);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('runs a second catch-up of the same connection after the first, and still holds live frames', async () => {
    const { engine } = build(replay.history());
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');
    await amara.send('__subscribe__', {}, general);
    await kofi.send('__subscribe__', {}, general);

    const since = kofi.resumeSeq();
    await kofi.close();

    await amara.send('preview-avatar', { size: 10, mark: 1 });
    await amara.send('share-screen', { frames: 2 }, general);
    await amara.send('preview-avatar', { size: 10, mark: 2 });

    const kofiAgain = await connect(engine, 'u_kofi', true);
    await kofiAgain.send('__subscribe__', {}, general);
    // Each frame fills the buffer, and the network empties it a little later.
    kofiAgain.buffered.afterSend = () => {
      kofiAgain.buffered.bytes = 512 * 1024;
      setTimeout(() => (kofiAgain.buffered.bytes = 0), 30);
    };
    kofiAgain.buffered.bytes = 512 * 1024;
    setTimeout(() => (kofiAgain.buffered.bytes = 0), 30);
    const topLevel = kofiAgain.send('__replay__', { lastKnownSeq: since });
    const room = kofiAgain.send('__replay__', { lastKnownSeq: since }, general);

    await topLevel;
    // The room's catch-up has rows left, so a live room frame must wait for them. The top
    // level is caught up, so its live frame goes out at once.
    await amara.send('share-screen', { frames: 1 }, general);
    await amara.send('save-avatar', { text: 'sent during the room catch-up' });
    await room;

    expect(userFrames(kofiAgain).map((frame) => frame.envelope[0])).toEqual([
      'avatar-preview',
      'avatar-preview',
      'avatar-saved',
      'screen-share-started',
      'screen-frame',
      'screen-frame',
      'screen-share-started',
      'screen-frame',
    ]);
  });

  it('does not wait on an adapter without backpressureSupported', async () => {
    const { engine } = build(replay.history());
    const amara = await connect(engine, 'u_amara');
    const since = amara.resumeSeq();
    await amara.send('preview-avatar', { size: 10, mark: 1 });
    await amara.send('preview-avatar', { size: 10, mark: 2 });

    await amara.close();

    const amaraAgain = await connect(engine, 'u_amara', false);
    amaraAgain.buffered.bytes = 512 * 1024;
    await amaraAgain.send('__replay__', { lastKnownSeq: since });

    expect(userFrames(amaraAgain)).toHaveLength(2);
  });
});

describe('what a catch-up holds back', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function waitingKofi(built: Built, previews = 3) {
    const amara = await connect(built.engine, 'u_amara');
    const kofi = await connect(built.engine, 'u_kofi');
    await amara.send('__subscribe__', {}, general);
    const since = kofi.resumeSeq();
    await kofi.close();

    for (let mark = 1; mark <= previews; mark += 1) {
      await amara.send('preview-avatar', { size: 10, mark });
    }

    const kofiAgain = await connect(built.engine, 'u_kofi', true);
    kofiAgain.buffered.bytes = 300 * 1024;
    const catchUp = kofiAgain.send('__replay__', { lastKnownSeq: since });

    return { amara, kofiAgain, catchUp };
  }

  /** The hold of the one connection that is catching up. */
  function holdOf(engine: Engine) {
    return [...engine.core.connections.values()].find((one) => one.catchUpHold)?.catchUpHold;
  }

  it('holds only the frames that carry a seq of the store it catches up', async () => {
    const built = build(replay.history());
    const { amara, kofiAgain, catchUp } = await waitingKofi(built);
    await new Promise((resolve) => setTimeout(resolve, 60));

    await kofiAgain.send('change-avatar');
    await kofiAgain.send('__subscribe__', {}, general);
    await amara.send('share-screen', { frames: 1 }, general);
    await amara.send('save-avatar', { text: 'sent during the catch-up' });

    expect(kofiAgain.frames().map((frame) => frame.envelope[0])).toEqual([
      '__resume__',
      'confirm-avatar',
      '__subscribeOk__',
      '__memberSync__',
      'screen-share-started',
      'screen-frame',
    ]);

    const request = kofiAgain.frames().find((frame) => frame.envelope[0] === 'confirm-avatar')!;
    const { exchange } = request.envelope[2] as { exchange: { id: string } };
    await kofiAgain.send(
      'confirm-avatar',
      { ok: true },
      { exchange: { ...exchange, source: 'server' } },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(built.requestResults).toEqual([{ ok: true }]);

    kofiAgain.buffered.bytes = 0;
    await catchUp;
    expect(
      userFrames(kofiAgain)
        .map((frame) => frame.envelope[0])
        .slice(-4),
    ).toEqual(['avatar-preview', 'avatar-preview', 'avatar-preview', 'avatar-saved']);
  });

  it('closes with 1013 a client whose buffer and held frames stay over twice sendBytes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const built = build(replay.history(), {
      messageLimits: { receiveBytes: 200_000, sendBytes: 200_000 },
    });
    const { amara, kofiAgain } = await waitingKofi(built);
    await vi.advanceTimersByTimeAsync(60);

    // 300 KiB in the socket plus 200 KB held is over 2 x 200 KB.
    for (let mark = 1; mark <= 10; mark += 1) {
      await amara.send('preview-avatar', { size: 20_000, mark });
    }

    const hold = holdOf(built.engine)!;
    expect(hold.bytes).toBeGreaterThan(200_000);
    expect(kofiAgain.closes).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_100);
    await amara.send('preview-avatar', { size: 20_000, mark: 11 });
    expect(kofiAgain.closes).toEqual([1013]);

    const heldAfterClose = hold.bytes;
    await amara.send('preview-avatar', { size: 20_000, mark: 12 });
    expect(hold.bytes).toBe(heldAfterClose);
  });

  it('stops when the connection closes while the catch-up waits for the buffer', async () => {
    const built = build(replay.history());
    const { kofiAgain, catchUp } = await waitingKofi(built);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const loadPage = vi.spyOn(ReplayRuntime, 'loadReplayPage');
    [...built.engine.core.connections.values()].find((one) => one.catchUpHold)!.closing = true;
    await catchUp;

    expect(loadPage).not.toHaveBeenCalled();
    expect(userFrames(kofiAgain)).toEqual([]);
  });

  it('closes with 1013 when the whole catch-up has waited about 50 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const built = build(replay.history());
    const { kofiAgain } = await waitingKofi(built);

    await vi.advanceTimersByTimeAsync(30_000);
    // The buffer empties once, one row goes out, and it fills again.
    kofiAgain.buffered.afterSend = () => (kofiAgain.buffered.bytes = 300 * 1024);
    kofiAgain.buffered.bytes = 0;
    await vi.advanceTimersByTimeAsync(50);
    expect(userFrames(kofiAgain)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(19_000);
    expect(kofiAgain.closes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_200);
    expect(kofiAgain.closes).toEqual([1013]);
    // A client that never reads the close frame is dropped a second later.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kofiAgain.closes).toEqual([1013, 'terminated']);
  });

  it('reports a gap only through the rows the catch-up covers, and loses no held frame', async () => {
    const { engine } = build(replay.history({ retention: { maxMessages: 300 } }));
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');
    const since = kofi.resumeSeq();
    await kofi.close();

    for (let index = 0; index < 300; index += 1) {
      await amara.send('save-avatar', { text: `note ${index}` });
    }

    const stored = userFrames(amara).map(seqOf);
    const kofiAgain = await connect(engine, 'u_kofi', true);
    let replayed = 0;
    kofiAgain.buffered.afterSend = () => {
      replayed += 1;
      if (replayed === 256) kofiAgain.buffered.bytes = 512 * 1024;
    };
    const catchUp = kofiAgain.send('__replay__', { lastKnownSeq: since });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 600 new rows push out all 300 old ones, and 300 of the new ones.
    for (let index = 0; index < 600; index += 1) {
      await amara.send('save-avatar', { text: `later ${index}` });
    }

    const live = userFrames(amara).map(seqOf).slice(300);
    kofiAgain.buffered.afterSend = undefined;
    kofiAgain.buffered.bytes = 0;
    await catchUp;

    const frames = kofiAgain.frames().filter((frame) => frame.envelope[0] !== '__resume__');
    const gapAt = frames.findIndex((frame) => frame.envelope[0] === '__gap__');
    expect(gapAt).toBe(256);
    expect(frames[gapAt]!.envelope[1]).toEqual({ missedThrough: stored.at(-1) });
    expect(frames.slice(gapAt + 1).map(seqOf)).toEqual(live);
  });
});

describe('rows replay does not store', () => {
  it('copies the bytes before a best-effort store, so a reused buffer does not change the row', async () => {
    const { engine, sql } = build(replay.history({ durability: 'best-effort' }));
    const amara = await connect(engine, 'u_amara');

    await amara.send('preview-then-reuse-buffer');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = sql
      .exec<{ binaryPayload: Uint8Array }>('SELECT binaryPayload FROM __livething_replay')
      .one()!;
    expect([...row.binaryPayload]).toEqual([1, 1, 1, 1]);
  });

  it('does not store a row too big to send, and warns once', async () => {
    const { engine, sql, warnings } = build(replay.history(), {
      messageLimits: { receiveBytes: 5000, sendBytes: 5000 },
    });
    const amara = await connect(engine, 'u_amara');

    await amara.send('preview-avatar', { size: 6000, mark: 1 });
    await amara.send('preview-avatar', { size: 6000, mark: 2 });
    await amara.send('preview-avatar', { size: 10, mark: 3 });

    expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM __livething_replay').one()!.n).toBe(
      1,
    );
    expect(warnings.map(([message]) => message)).toEqual([
      expect.stringMatching(/"avatar-preview" .*over the send limit of 5000 bytes/),
    ]);
  });

  it('does not store one row bigger than maxBytes, and keeps the older rows', async () => {
    const { engine, sql, warnings } = build(replay.history({ retention: { maxBytes: 2500 } }));
    const amara = await connect(engine, 'u_amara');

    await amara.send('preview-avatar', { size: 500, mark: 1 });
    await amara.send('preview-avatar', { size: 500, mark: 2 });
    await amara.send('preview-avatar', { size: 3000, mark: 3 });

    expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM __livething_replay').one()!.n).toBe(
      2,
    );
    expect(warnings.map(([message]) => message)).toEqual([
      expect.stringMatching(/"avatar-preview" .*over retention\.maxBytes of 2500 bytes/),
    ]);
  });
});

describe('snapshot retention by bytes', () => {
  it('sums the store only when the cached total could be over maxBytes', async () => {
    let sums = 0;
    const built = build(replay.snapshot({ exclude: ['avatar-preview', 'screen-frame'] }));
    const exec = built.sql.exec.bind(built.sql);
    built.sql.exec = ((query: string, ...params: unknown[]) => {
      if (/SUM\(rowBytes\)/.test(query)) sums += 1;
      return exec(query, ...params);
    }) as typeof built.sql.exec;
    const amara = await connect(built.engine, 'u_amara');

    for (let index = 0; index < 20; index += 1) {
      await amara.send('save-avatar', { text: `status ${index}` });
    }

    expect(sums).toBeLessThanOrEqual(1);
  });
});

describe('catch-up in pages', () => {
  it('sends a long catch-up in seq order, page by page', async () => {
    const { engine, sql } = build(replay.history());
    const amara = await connect(engine, 'u_amara');
    const since = amara.resumeSeq();
    for (let index = 0; index < 600; index += 1) {
      await amara.send('save-avatar', { text: `note ${index}` });
    }

    const live = userFrames(amara);
    await amara.close();

    const loads: number[] = [];
    const exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...params: unknown[]) => {
      const result = exec(query, ...params);
      if (!/SELECT[\s\S]*binaryPayload[\s\S]*FROM __livething_replay\b/.test(query)) return result;

      const rows = result.toArray();
      loads.push(rows.length);

      return { toArray: () => rows, one: () => rows[0] ?? null, raw: () => [] };
    }) as typeof sql.exec;

    const amaraAgain = await connect(engine, 'u_amara');
    await amaraAgain.send('__replay__', { lastKnownSeq: since });

    expect(userFrames(amaraAgain)).toEqual(live);
    expect(loads.length).toBeGreaterThan(1);
    expect(Math.max(...loads)).toBeLessThan(600);
  });

  it('sends __gap__ when rows it had not sent yet were deleted while it waited', async () => {
    const { engine } = build(replay.history({ retention: { maxMessages: 300 } }));
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');
    const since = kofi.resumeSeq();
    await kofi.close();

    for (let index = 0; index < 300; index += 1) {
      await amara.send('save-avatar', { text: `note ${index}` });
    }

    const kofiAgain = await connect(engine, 'u_kofi', true);
    let replayed = 0;
    kofiAgain.buffered.afterSend = () => {
      replayed += 1;
      // The buffer fills after the first page, and stays full until amara has sent more.
      if (replayed === 256) kofiAgain.buffered.bytes = 512 * 1024;
    };
    const catchUp = kofiAgain.send('__replay__', { lastKnownSeq: since });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(replayed).toBe(256);

    // 280 new rows push out the 280 oldest, so rows 257 to 280 are gone before kofi gets them.
    for (let index = 0; index < 280; index += 1) {
      await amara.send('save-avatar', { text: `later ${index}` });
    }

    kofiAgain.buffered.afterSend = undefined;
    kofiAgain.buffered.bytes = 0;
    await catchUp;

    const frames = kofiAgain.frames().filter((frame) => frame.envelope[0] !== '__resume__');
    const gapAt = frames.findIndex((frame) => frame.envelope[0] === '__gap__');
    expect(gapAt).toBe(256);
    const missedThrough = (frames[gapAt]!.envelope[1] as { missedThrough: number }).missedThrough;
    const after = frames.slice(gapAt + 1).map(seqOf);

    expect(after.every((seq) => seq > missedThrough)).toBe(true);
    expect(after).toEqual([...after].sort((a, b) => a - b));
    expect(new Set(after).size).toBe(after.length);
  });
});

describe('ctx.binary.sendReplay', () => {
  it('sends one stored binary message again as a binary frame, with the wire given', async () => {
    const { engine } = build(replay.history());
    const amara = await connect(engine, 'u_amara');
    await amara.send('__subscribe__', {}, general);

    await amara.send('resend-avatar-preview', { deliverySeq: 7, messageId: 'm-7' });
    await amara.send('resend-screen-frame', { deliverySeq: 8, messageId: 'm-8' }, general);

    expect(userFrames(amara)).toEqual([
      {
        envelope: ['avatar-preview', { userId: 'u_amara' }, { delivery: { id: 'm-7', seq: 7 } }],
        bytes: [4, 4, 4],
      },
      {
        envelope: [
          'screen-frame',
          { from: 'u_amara' },
          { channel: { name: 'room:general', family: 'rooms' }, delivery: { id: 'm-7', seq: 7 } },
        ],
        bytes: [5, 5],
      },
      {
        envelope: [
          'screen-frame',
          { from: 'u_amara' },
          { channel: { name: 'room:general', family: 'rooms' }, delivery: { id: 'm-8', seq: 8 } },
        ],
        bytes: [6, 6],
      },
    ]);
  });

  it('refuses the wrong kind of event, as the other senders do', async () => {
    const { engine, sendReplayErrors } = build(replay.history());
    const amara = await connect(engine, 'u_amara');

    await amara.send('resend-wrong-kind');

    expect(sendReplayErrors).toEqual([
      expect.stringMatching(/"avatar-preview" is declared in binary\(\{ emits \}\)/),
      expect.stringMatching(/"avatar-saved" is declared as a JSON event/),
    ]);
    expect(userFrames(amara)).toEqual([]);
  });
});

describe('snapshot mode', () => {
  it('refuses binary events at startup', async () => {
    await expect(build(replay.snapshot()).engine.initialize()).rejects.toThrow(
      /replay\.snapshot\(\) cannot store the binary event 'avatar-preview'.*history mode.*exclude/,
    );
    await expect(
      build(replay.snapshot({ exclude: ['avatar-preview'] })).engine.initialize(),
    ).rejects.toThrow(/the binary event 'screen-frame' of channel 'rooms'/);
  });

  it('starts when every binary event is excluded', async () => {
    await expect(
      build(replay.snapshot({ exclude: ['avatar-preview', 'screen-frame'] })).engine.initialize(),
    ).resolves.toBeUndefined();
  });
});
