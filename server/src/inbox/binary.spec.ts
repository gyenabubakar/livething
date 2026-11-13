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
import { inbox } from '~/inbox/capability.ts';
import { loadUndeliveredRows } from '~/inbox/storage.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineRuntimeOptions, TransportFrame } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { SqlLimits } from '~/context.ts';
import type { InboxOptions } from '~/inbox/types.ts';

const general = { channel: { name: 'room:general', family: 'rooms' } };

/** A picture of `size` bytes whose values tell the pictures apart. */
function picture(size: number, mark: number): Uint8Array {
  return new Uint8Array(size).fill(mark);
}

interface BuildOptions {
  inbox?: InboxOptions;
  limits?: Partial<SqlLimits>;
  messageLimits?: EngineRuntimeOptions['messageLimits'];
  sql?: ReturnType<typeof createTestSql>;
}

function build(options: BuildOptions = {}) {
  const errors: unknown[][] = [];
  /** What each `backfill-*` handler threw. */
  const backfillErrors: string[] = [];
  const sql = options.sql ?? createTestSql(options.limits ? { limits: options.limits } : {});
  const base = server({
    capabilities: [binary(), channels(), dedup(), sequence({ persist: true }), replay.history()],
  });
  // A channel with no binary events, so its inbox keeps the JSON defaults.
  const notes = base.channel('notes', {
    membership: 'persistent',
    capabilities: [emits({ note: t<{ text: string }>() }), inbox()],
  });
  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    membership: 'persistent',
    capabilities: [
      binary({ emits: { 'screen-frame': t<{ from: string }>() } }),
      emits({ 'chat-message': t<{ text: string }>() }),
      inbox(options.inbox),
    ],
  });
  const shareScreen = rooms.on('share-screen', {
    input: v.object({ size: v.number(), mark: v.number() }),
    run(ctx, input) {
      ctx.channel.binary.broadcast(
        'screen-frame',
        { from: ctx.user.id },
        picture(input.size, input.mark),
      );
    },
  });

  const sendMessage = rooms.on('send-message', {
    input: v.object({ text: v.string(), times: v.optional(v.number()) }),
    run(ctx, input) {
      for (let i = 0; i < (input.times ?? 1); i += 1) {
        ctx.channel.broadcast('chat-message', { text: input.text });
      }
    },
  });
  // Seed a member's inbox with earlier screen frames, as an import from another system does.
  const BackfillInput = v.object({
    userId: v.string(),
    size: v.number(),
    messageId: v.string(),
    /** How many characters to add to the info, to make it big. */
    fromSize: v.optional(v.number()),
  });
  function recordBackfill(run: () => void): void {
    try {
      run();
    } catch (error) {
      backfillErrors.push((error as Error).message);
    }
  }

  const backfillScreenFrames = rooms.on('backfill-screen-frames', {
    input: BackfillInput,
    run(ctx, input) {
      recordBackfill(() =>
        ctx.channel.inbox.binary.backfill(input.userId, [
          {
            event: 'screen-frame',
            info: { from: `u_amara${'x'.repeat(input.fromSize ?? 0)}` },
            bytes: picture(input.size, 5),
            __livething: { messageId: input.messageId },
          },
        ]),
      );
    },
  });
  const backfillMessages = rooms.on('backfill-messages', {
    input: BackfillInput,
    run(ctx, input) {
      recordBackfill(() =>
        ctx.channel.inbox.backfill(input.userId, [
          {
            event: 'chat-message',
            payload: { text: 'x'.repeat(input.size) },
            __livething: { messageId: input.messageId },
          },
        ]),
      );
    },
  });
  const definition = base.assemble({
    handlers: [rooms, notes, shareScreen, sendMessage, backfillScreenFrames, backfillMessages],
  });

  let engine!: Engine;
  adapter({
    id: 'inbox-binary-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql, kv: createTestKV() },
        timers: createTestTimers(),
        platform: {},
        logger: { info() {}, warn() {}, error: (...args: unknown[]) => errors.push(args) },
        ...(options.messageLimits ? { messageLimits: options.messageLimits } : {}),
      });
      return {};
    },
  })(definition, undefined as never);

  return { engine, errors, sql, backfillErrors };
}

/** What a socket reports as buffered. A socket made with it reports backpressure. */
interface Buffered {
  bytes: number;
}

async function connect(engine: Engine, userId: string, buffered?: Buffered) {
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

  /** Every frame in order: a binary frame as its envelope and bytes, a text frame as JSON. */
  function frames() {
    return sent.map((data) => {
      if (data.kind === 'text') return { envelope: JSON.parse(data.text) as unknown[] };

      const split = splitBinaryFrame(data.bytes);
      if (split.kind !== 'frame') throw new Error(`not a LiveThing frame: ${split.kind}`);

      return { envelope: JSON.parse(split.envelope) as unknown[], bytes: [...split.bytes] };
    });
  }

  function send(event: string, payload: unknown = null, metadata: unknown = general) {
    return handle.handleMessage(JSON.stringify([event, payload, metadata]));
  }

  return {
    sent,
    closes,
    frames,
    /** The app frames, without the framework ones. */
    appFrames: () => frames().filter((frame) => !String(frame.envelope[0]).startsWith('__')),
    send,
    subscribe: () => send('__subscribe__', {}),
    close: () => handle.handleClose(1006, 'dropped'),
  };
}

type Member = Awaited<ReturnType<typeof connect>>;

function seqOf(frame: { envelope: unknown[] }): number {
  return (frame.envelope[2] as { delivery: { seq: number } }).delivery.seq;
}

/** Wait until the reconnect's rejoin and inbox drain have run. */
async function untilTrue(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;

    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  throw new Error('condition never became true');
}

/** Kofi joins the room and leaves; Amara stays in it. */
async function kofiOffline(engine: Engine): Promise<Member> {
  const kofi = await connect(engine, 'u_kofi');
  await kofi.subscribe();
  await kofi.close();

  const amara = await connect(engine, 'u_amara');
  await amara.subscribe();

  return amara;
}

/** Kofi comes back. The rejoin then the inbox drain run after the connect. */
async function kofiBack(engine: Engine, buffered?: Buffered): Promise<Member> {
  const kofi = await connect(engine, 'u_kofi', buffered);
  await untilTrue(() => kofi.frames().some((frame) => frame.envelope[0] === '__subscribeOk__'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  return kofi;
}

function countRows(sql: ReturnType<typeof createTestSql>): number {
  return sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM __livething_inbox').one()!.n;
}

describe('inbox stores binary broadcasts', () => {
  it('sends a member who was offline the binary broadcast later, as one binary frame with the metadata of the live frame', async () => {
    const { engine } = build();
    const amara = await kofiOffline(engine);
    const esi = await connect(engine, 'u_esi');
    await esi.subscribe();

    await amara.send('share-screen', { size: 3, mark: 7 });
    const kofi = await kofiBack(engine);

    const [live] = esi.appFrames();
    const [stored] = kofi.appFrames();
    expect(kofi.sent.filter((frame) => frame.kind === 'bytes')).toHaveLength(1);
    expect(stored).toEqual(live);
    expect(stored!.bytes).toEqual([7, 7, 7]);

    expect(stored!.envelope).toEqual([
      'screen-frame',
      { from: 'u_amara' },
      {
        channel: { name: 'room:general', family: 'rooms' },
        delivery: { id: expect.any(String), seq: expect.any(Number) },
      },
    ]);
  });

  it('sends stored JSON and binary rows in seq order', async () => {
    const { engine } = build();
    const amara = await kofiOffline(engine);

    await amara.send('send-message', { text: 'look' });
    await amara.send('share-screen', { size: 2, mark: 1 });
    await amara.send('send-message', { text: 'and now' });
    await amara.send('share-screen', { size: 2, mark: 2 });
    const kofi = await kofiBack(engine);

    const frames = kofi.appFrames();
    expect(frames.map((frame) => frame.envelope[0])).toEqual([
      'chat-message',
      'screen-frame',
      'chat-message',
      'screen-frame',
    ]);
    expect(frames.map((frame) => frame.bytes)).toEqual([undefined, [1, 1], undefined, [2, 2]]);
    const seqs = frames.map(seqOf);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('deletes a binary row when the member acknowledges it', async () => {
    const { engine, sql } = build();
    const amara = await kofiOffline(engine);
    await amara.send('share-screen', { size: 2, mark: 1 });
    expect(countRows(sql)).toBe(1);

    const kofi = await kofiBack(engine);
    await kofi.send('__received__', { receivedThrough: seqOf(kofi.appFrames()[0]!) });

    expect(loadUndeliveredRows(sql, 'u_kofi')).toEqual([]);
  });
});

describe('a broadcast the inbox cannot store', () => {
  it('goes to nobody when it is over the storage row limit, and LiveThing logs one error for each event and limit', async () => {
    const { engine, errors, sql } = build({ limits: { maxValueBytes: 2000 } });
    const amara = await kofiOffline(engine);
    const esi = await connect(engine, 'u_esi');
    await esi.subscribe();

    await amara.send('share-screen', { size: 3000, mark: 1 });
    await amara.send('share-screen', { size: 3000, mark: 2 });
    await amara.send('send-message', { text: 'x'.repeat(3000) });
    await amara.send('share-screen', { size: 10, mark: 3 });

    expect(esi.appFrames().map((frame) => frame.bytes)).toEqual([new Array(10).fill(3)]);
    expect(loadUndeliveredRows(sql, 'u_kofi').map((row) => row.event)).toEqual(['screen-frame']);
    expect(errors.map(([message]) => message)).toEqual([
      expect.stringMatching(/"screen-frame".*over the storage row limit of 2000 bytes/),
      expect.stringMatching(/"chat-message".*over the storage row limit of 2000 bytes/),
    ]);
  });

  it('goes to nobody when it is over the send limit', async () => {
    const { engine, errors, sql } = build({
      messageLimits: { receiveBytes: 5000, sendBytes: 5000 },
    });
    const amara = await kofiOffline(engine);
    const esi = await connect(engine, 'u_esi');
    await esi.subscribe();

    await amara.send('share-screen', { size: 6000, mark: 1 });

    expect(esi.appFrames()).toEqual([]);
    expect(countRows(sql)).toBe(0);
    expect(errors.map(([message]) => message)).toEqual([
      expect.stringMatching(/"screen-frame".*over the send limit of 5000 bytes/),
    ]);
  });

  it('goes to nobody when it alone is over retention.maxBytes, and the older rows stay', async () => {
    const { engine, errors, sql } = build({ inbox: { retention: { maxBytes: 2500 } } });
    const amara = await kofiOffline(engine);

    await amara.send('share-screen', { size: 500, mark: 1 });
    await amara.send('share-screen', { size: 3000, mark: 2 });

    expect(countRows(sql)).toBe(1);
    expect(errors.map(([message]) => message)).toEqual([
      expect.stringMatching(/"screen-frame".*over retention\.maxBytes of 2500 bytes/),
    ]);
  });
});

describe('inbox retention.maxBytes', () => {
  it('deletes the oldest rows of a member over the limit, and the member gets a gap for them', async () => {
    // Each row is 100 bytes of picture plus 18 bytes of info.
    const { engine } = build({ inbox: { retention: { maxBytes: 250 } } });
    const amara = await kofiOffline(engine);

    await amara.send('share-screen', { size: 100, mark: 1 });
    await amara.send('share-screen', { size: 100, mark: 2 });
    await amara.send('share-screen', { size: 100, mark: 3 });
    const kofi = await kofiBack(engine);

    const gap = kofi.frames().find((frame) => frame.envelope[0] === '__gap__');
    const frames = kofi.appFrames();
    expect(frames.map((frame) => frame.bytes![0])).toEqual([2, 3]);
    expect(gap!.envelope[1]).toEqual({ missedThrough: seqOf(frames[0]!) - 1 });
  });

  it('holds rows already stored to a lowered limit when the server starts', async () => {
    const first = build();
    const amara = await kofiOffline(first.engine);
    await amara.send('share-screen', { size: 100, mark: 1 });
    await amara.send('share-screen', { size: 100, mark: 2 });
    expect(countRows(first.sql)).toBe(2);

    const second = build({ sql: first.sql, inbox: { retention: { maxBytes: 150 } } });
    await second.engine.initialize();

    expect(countRows(first.sql)).toBe(1);
  });

  it('must be a positive integer', () => {
    expect(() => build({ inbox: { retention: { maxBytes: 0 } } })).toThrow(/retention\.maxBytes/);
  });

  it('is 64 MiB when the channel lists binary events and sets none, and stays unset on a JSON channel', async () => {
    const { engine } = build({ inbox: { retention: { maxMessages: 100 } } });
    await engine.initialize();
    const plain = build();
    await plain.engine.initialize();

    expect(engine.core.inboxChannels.get('rooms')?.retention).toEqual({
      maxMessages: 100,
      maxBytes: 64 * 1024 * 1024,
    });
    expect(plain.engine.core.inboxChannels.get('notes')?.retention).toBeUndefined();
    const own = build({ inbox: { retention: { maxBytes: 1000 } } });
    await own.engine.initialize();
    expect(own.engine.core.inboxChannels.get('rooms')?.retention).toEqual({ maxBytes: 1000 });
  });
});

describe('a refused inbox broadcast and replay', () => {
  it('is not recorded by replay either, so no client gets it back later', async () => {
    // Replay could store this message: only the inbox's own limit refuses it.
    const { engine, sql } = build({ inbox: { retention: { maxBytes: 2500 } } });
    const amara = await kofiOffline(engine);

    await amara.send('share-screen', { size: 3000, mark: 1 });
    expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM __livething_replay').one()!.n).toBe(
      0,
    );

    await amara.send('share-screen', { size: 10, mark: 2 });
    expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM __livething_replay').one()!.n).toBe(
      1,
    );
  });
});

describe('the inbox drain', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads each page with a seek on the primary key and no sort, so a long drain stays linear', async () => {
    const pages: { query: string; params: readonly unknown[] }[] = [];
    let watching = false;
    const sql = createTestSql({
      onExec(query, params) {
        if (watching && /ORDER BY channel_name, channel_family, seq/.test(query)) {
          pages.push({ query, params });
        }
      },
    });
    const { engine } = build({ sql });
    const amara = await kofiOffline(engine);

    await amara.send('send-message', { text: 'hello', times: 300 });

    watching = true;
    const kofi = await kofiBack(engine);
    await untilTrue(() => kofi.appFrames().length === 300);
    watching = false;

    expect(pages.length).toBeGreaterThan(2);
    for (const { query, params } of pages) {
      const plan = sql.db
        .prepare(`EXPLAIN QUERY PLAN ${query.trim()}`)
        .all(...(params as never[]))
        .map((step) => String(step.detail))
        .join(' | ');
      expect(plan).toMatch(/USING INDEX sqlite_autoindex___livething_inbox_1/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
  });

  it('sends more rows than one page, all of them, in seq order', async () => {
    const { engine } = build();
    const amara = await kofiOffline(engine);
    await amara.send('send-message', { text: 'hello', times: 300 });

    const kofi = await kofiBack(engine);
    await untilTrue(() => kofi.appFrames().length === 300);

    const seqs = kofi.appFrames().map(seqOf);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(300);
  });

  it('waits while the socket buffer is high, and holds live frames of the channel until it ends', async () => {
    const { engine } = build();
    const amara = await kofiOffline(engine);
    await amara.send('share-screen', { size: 10, mark: 1 });
    await amara.send('share-screen', { size: 10, mark: 2 });

    const buffered = { bytes: 512 * 1024 };
    const kofi = await kofiBack(engine, buffered);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(kofi.appFrames()).toEqual([]);

    await amara.send('send-message', { text: 'sent during the drain' });
    expect(kofi.appFrames()).toEqual([]);

    buffered.bytes = 0;
    await untilTrue(() => kofi.appFrames().length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const frames = kofi.appFrames();
    expect(frames.map((frame) => frame.envelope[0])).toEqual([
      'screen-frame',
      'screen-frame',
      'chat-message',
    ]);

    const seqs = frames.map(seqOf);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('sends a gap for rows retention deletes while it waits, before the rows after them', async () => {
    const { engine } = build({ inbox: { retention: { maxMessages: 2 } } });
    const amara = await kofiOffline(engine);
    await amara.send('share-screen', { size: 10, mark: 1 });
    await amara.send('share-screen', { size: 10, mark: 2 });

    const buffered = { bytes: 512 * 1024 };
    const kofi = await kofiBack(engine, buffered);
    // Two more frames push both stored ones out of Kofi's inbox while the drain waits.
    await amara.send('share-screen', { size: 10, mark: 3 });
    await amara.send('share-screen', { size: 10, mark: 4 });
    buffered.bytes = 0;
    await untilTrue(() => kofi.appFrames().length >= 2);

    const after = kofi.frames().slice(kofi.frames().findIndex((f) => f.envelope[0] === '__gap__'));
    expect(after.map((frame) => frame.envelope[0])).toEqual([
      '__gap__',
      'screen-frame',
      'screen-frame',
    ]);
    expect(after.slice(1).map((frame) => frame.bytes![0])).toEqual([3, 4]);
  });

  it('closes with 1013 a member whose buffer stays high for the whole wait, about 50 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const { engine } = build();
    const amara = await kofiOffline(engine);
    await amara.send('share-screen', { size: 10, mark: 1 });

    const buffered = { bytes: 512 * 1024 };
    const kofi = await connect(engine, 'u_kofi', buffered);
    await vi.advanceTimersByTimeAsync(49_000);
    expect(kofi.closes).toEqual([]);
    expect(kofi.appFrames()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_200);
    expect(kofi.closes).toEqual([1013]);
  });
});

describe('a backfill while a drain waits', () => {
  for (const kind of ['binary', 'JSON'] as const) {
    it(`holds the backfilled ${kind} frame until the drain has sent the older rows, so an ack loses nothing`, async () => {
      const { engine, sql } = build();
      const amara = await kofiOffline(engine);
      await amara.send('send-message', { text: 'owed', times: 2 });

      const buffered = { bytes: 512 * 1024 };
      const kofi = await kofiBack(engine, buffered);
      const event = kind === 'binary' ? 'backfill-screen-frames' : 'backfill-messages';
      await amara.send(event, { userId: 'u_kofi', size: 4, messageId: 'old-1' });
      expect(kofi.appFrames()).toEqual([]);

      buffered.bytes = 0;
      await untilTrue(() => kofi.appFrames().length >= 3);
      const frames = kofi.appFrames();
      expect(frames).toHaveLength(3);
      const seqs = frames.map(seqOf);

      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

      // The client acks the highest seq it got: every row it acks, it has.
      await kofi.send('__received__', { receivedThrough: Math.max(...seqs) });
      expect(loadUndeliveredRows(sql, 'u_kofi')).toEqual([]);
    });
  }
});

describe('inbox binary backfill', () => {
  it('throws, and stores nothing, for info and metadata over the 64 KiB envelope limit', async () => {
    const { engine, sql, backfillErrors } = build();
    const amara = await kofiOffline(engine);

    await amara.send('backfill-screen-frames', {
      userId: 'u_kofi',
      size: 4,
      messageId: 'big-info',
      fromSize: 70_000,
    });

    expect(backfillErrors).toEqual([expect.stringMatching(/64 KiB/)]);
    expect(countRows(sql)).toBe(0);
  });

  it('stores binary frames for a member who is away, and the drain sends them as binary frames', async () => {
    const { engine } = build();
    const amara = await kofiOffline(engine);

    await amara.send('backfill-screen-frames', { userId: 'u_kofi', size: 4, messageId: 'old-1' });
    const kofi = await kofiBack(engine);

    const [frame] = kofi.appFrames();
    expect(frame!.bytes).toEqual([5, 5, 5, 5]);
    expect(frame!.envelope).toEqual([
      'screen-frame',
      { from: 'u_amara' },
      {
        channel: { name: 'room:general', family: 'rooms' },
        delivery: { id: 'old-1', seq: expect.any(Number) },
      },
    ]);
  });

  it('sends them straight away to a member who is in the channel', async () => {
    const { engine } = build();
    const amara = await kofiOffline(engine);
    const esi = await connect(engine, 'u_esi');
    await esi.subscribe();

    await amara.send('backfill-screen-frames', { userId: 'u_esi', size: 3, messageId: 'old-1' });

    expect(esi.appFrames().map((frame) => frame.bytes)).toEqual([[5, 5, 5]]);
  });

  it('throws, and stores nothing, for a message the inbox cannot store, binary or JSON', async () => {
    const { engine, sql, backfillErrors } = build({ limits: { maxValueBytes: 2000 } });
    const amara = await kofiOffline(engine);

    await amara.send('backfill-screen-frames', { userId: 'u_kofi', size: 3000, messageId: 'a' });
    await amara.send('backfill-messages', { userId: 'u_kofi', size: 3000, messageId: 'b' });

    expect(backfillErrors).toEqual([
      expect.stringMatching(/"screen-frame".*over the storage row limit of 2000 bytes/),
      expect.stringMatching(/"chat-message".*over the storage row limit of 2000 bytes/),
    ]);
    expect(countRows(sql)).toBe(0);
  });
});
