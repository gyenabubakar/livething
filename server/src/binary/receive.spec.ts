import { AsyncLocalStorage } from 'node:async_hooks';
import { BINARY_ENVELOPE_LIMIT, CloseCodes, encodeBinaryFrame } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { rateLimit } from '~/rate-limit/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { EngineRuntimeOptions, TransportFrame } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { ServerDefinition } from '~/server-definition.ts';

const general = { channel: { name: 'room:general', family: 'rooms' } };
const picture = new Uint8Array([137, 80, 78, 71]);

function frameOf(envelope: [event: string, info: unknown, metadata: unknown], bytes: Uint8Array) {
  return encodeBinaryFrame(JSON.stringify(envelope), bytes);
}

function frame(event: string, info: unknown, metadata: unknown): Uint8Array {
  return frameOf([event, info, metadata], picture);
}

function build(
  definition: ServerDefinition,
  messageLimits?: EngineRuntimeOptions['messageLimits'],
) {
  const warnings: unknown[][] = [];
  let engine!: Engine;
  adapter({
    id: 'binary-receive-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql: createTestSql(), kv: createTestKV() },
        timers: createTestTimers(),
        platform: {},
        logger: {
          info: vi.fn(),
          warn: (...args: unknown[]) => warnings.push(args),
          error: vi.fn(),
        },
        ...(messageLimits ? { messageLimits } : {}),
      });
      return {};
    },
  })(definition, undefined as never);
  return { engine, warnings };
}

async function connect(engine: Engine, userId = 'u_amara') {
  await engine.initialize();
  const sent: TransportFrame[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const handle = engine.accept(Symbol(userId), {
    send: (data: TransportFrame) => sent.push(data),
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
    bufferedAmount: () => 0,
    userId,
  });
  const connection = [...engine.core.connections.values()].at(-1)!;

  await connection.lifecycleReady;

  function texts(): unknown[][] {
    return sent.flatMap((data) => (data.kind === 'text' ? [JSON.parse(data.text)] : []));
  }

  return {
    handle,
    sent,
    closes,
    connection,
    texts,
    errorCodes: () =>
      texts()
        .filter((data) => data[0] === '__error__')
        .map((data) => (data[1] as { code: string }).code),
    errors: () => texts().filter((data) => data[0] === '__error__'),
    subscribe: async () => {
      await handle.handleMessage(JSON.stringify(['__subscribe__', {}, general]));
    },
  };
}

interface Seen {
  info: unknown;
  bytes: Uint8Array;
  room?: string;
}

function huddle(seen: Seen[], extra: { onIntercept?: (frame: InterceptFrame) => unknown } = {}) {
  const base = server({
    capabilities: [binary({ emits: { 'avatar-preview': t<null>() } }), channels(), stream()],
    intercept(_ctx, interceptFrame) {
      return extra.onIntercept?.(interceptFrame);
    },
  });
  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    capabilities: [binary({ emits: { 'screen-frame': t<{ from: string }>() } })],
  });
  const handleUploadAvatar = base.binary.on('upload-avatar', {
    input: v.object({ fileType: v.picklist(['image/png', 'image/jpeg']) }),
    maxBytes: 8,
    run(_ctx, input, bytes) {
      seen.push({ info: input, bytes });
    },
  });
  const handleRenameUser = base.on('rename-user', {
    input: v.object({ name: v.string() }),
    run() {},
  });
  const handleShareScreenFrame = rooms.binary.on('share-screen-frame', {
    input: v.null(),
    run(ctx, input, bytes) {
      seen.push({ info: input, bytes, room: ctx.channel.name });
    },
  });

  const handleExportRoom = base.stream('export-room', {
    nudges: { 'pause-export': null },
    async *run() {
      yield { page: 1 };
      await new Promise(() => {});
    },
  });

  return base.assemble({
    handlers: [handleUploadAvatar, handleRenameUser, handleShareScreenFrame, handleExportRoom],
  });
}

describe('a binary event', () => {
  it('reaches its handler with the checked info and a plain Uint8Array of the bytes', async () => {
    const seen: Seen[] = [];
    const { engine } = build(huddle(seen));
    const { handle, errorCodes } = await connect(engine);

    await handle.handleBinaryMessage(frame('upload-avatar', { fileType: 'image/png' }, null));

    expect(errorCodes()).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.info).toEqual({ fileType: 'image/png' });
    expect(Object.getPrototypeOf(seen[0]!.bytes)).toBe(Uint8Array.prototype);
    expect([...seen[0]!.bytes]).toEqual([...picture]);

    expect([...seen[0]!.bytes.slice()]).toEqual([...picture]);
  });

  it('reaches a channel handler for a member', async () => {
    const seen: Seen[] = [];
    const { engine } = build(huddle(seen));
    const { handle, errorCodes, subscribe } = await connect(engine);
    await subscribe();

    await handle.handleBinaryMessage(frame('share-screen-frame', null, general));

    expect(errorCodes()).toEqual([]);
    expect(seen.map((entry) => entry.room)).toEqual(['room:general']);
  });

  it('gives a Node Buffer from a pooled slice as a plain view with the right offset', async () => {
    const seen: Seen[] = [];
    const { engine } = build(huddle(seen));
    const { handle } = await connect(engine);
    const encoded = frame('upload-avatar', { fileType: 'image/png' }, null);
    const pool = Buffer.alloc(encoded.byteLength + 16);

    pool.set(encoded, 7);

    await handle.handleBinaryMessage(pool.subarray(7, 7 + encoded.byteLength));

    expect([...seen[0]!.bytes]).toEqual([...picture]);
    expect(Object.getPrototypeOf(seen[0]!.bytes)).toBe(Uint8Array.prototype);
  });
});

describe('frames the server rejects (spec 6.5)', () => {
  it('closes with 1003 for binary data without the magic', async () => {
    const { engine } = build(huddle([]));
    const { handle, closes } = await connect(engine);

    await handle.handleBinaryMessage(new Uint8Array([1, 2, 3, 4, 5]));

    expect(closes.map((close) => close.code)).toEqual([CloseCodes.UNSUPPORTED_DATA]);
  });

  it('closes with 1009 for a binary frame over receiveBytes', async () => {
    const { engine } = build(huddle([]), { receiveBytes: 70_000, sendBytes: 70_000 });
    const { handle, closes } = await connect(engine);

    await handle.handleBinaryMessage(
      frameOf(['upload-avatar', { fileType: 'image/png' }, null], new Uint8Array(70_000)),
    );

    expect(closes.map((close) => close.code)).toEqual([CloseCodes.MESSAGE_TOO_BIG]);
  });

  it.each([
    ['a broken header', new Uint8Array([0x6c, 0x74, 0x62, 0x66, 9, 0, 0, 0, 0])],
    [
      'an envelope length past the end',
      (() => {
        const data = frame('upload-avatar', null, null);
        new DataView(data.buffer).setUint32(5, 4000, false);
        return data;
      })(),
    ],
    [
      'an envelope over 64 KiB',
      (() => {
        const data = new Uint8Array(9 + BINARY_ENVELOPE_LIMIT + 1);
        data.set([0x6c, 0x74, 0x62, 0x66, 1]);
        new DataView(data.buffer).setUint32(5, BINARY_ENVELOPE_LIMIT + 1, false);
        return data;
      })(),
    ],
    ['bad JSON', encodeBinaryFrame('["upload-avatar",', picture)],
    ['an envelope that is not a three-item array', encodeBinaryFrame('["upload-avatar",null]')],
  ])('logs and drops a frame with %s, and keeps the socket open', async (_name, data) => {
    const seen: Seen[] = [];
    const { engine, warnings } = build(huddle(seen));
    const { handle, closes, sent } = await connect(engine);
    const before = sent.length;

    await handle.handleBinaryMessage(data);

    expect(closes).toEqual([]);
    expect(sent.length).toBe(before);
    expect(seen).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('answers validation-failed for a bad metadata shape', async () => {
    const { engine } = build(huddle([]));
    const { handle, errorCodes } = await connect(engine);

    await handle.handleBinaryMessage(frame('upload-avatar', null, { unknown: true }));

    expect(errorCodes()).toEqual(['validation-failed']);
  });

  it.each(['__subscribe__', '__unsubscribe__', '__streamCancel__', '__error__'])(
    'answers wrong-frame-kind for the framework event %s',
    async (event) => {
      const { engine } = build(huddle([]));
      const { handle, errors, connection } = await connect(engine);

      await handle.handleBinaryMessage(frame(event, {}, general));

      expect(errors()).toEqual([
        [
          '__error__',
          { code: 'wrong-frame-kind', detail: { event, expected: 'text' } },
          expect.anything(),
        ],
      ]);
      expect(connection.channelMemberships.size).toBe(0);
    },
  );

  it('answers wrong-frame-kind for a binary __error__ that carries a correlation id', async () => {
    const { engine } = build(huddle([]));
    const { handle, errorCodes } = await connect(engine);

    await handle.handleBinaryMessage(
      frame('__error__', { code: 'x' }, { exchange: { id: 'r-1', source: 'server' } }),
    );

    expect(errorCodes()).toEqual(['wrong-frame-kind']);
  });

  it('answers wrong-frame-kind for a binary frame sent to a JSON handler', async () => {
    const { engine } = build(huddle([]));
    const { handle, errors } = await connect(engine);

    await handle.handleBinaryMessage(frame('rename-user', { name: 'Amara' }, null));

    expect(errors()).toEqual([
      [
        '__error__',
        { code: 'wrong-frame-kind', detail: { event: 'rename-user', expected: 'text' } },
        null,
      ],
    ]);
  });

  it('answers wrong-frame-kind for a text frame sent to a binary handler', async () => {
    const seen: Seen[] = [];
    const { engine } = build(huddle(seen));
    const { handle, errors } = await connect(engine);

    await handle.handleMessage(JSON.stringify(['upload-avatar', { fileType: 'image/png' }, null]));

    expect(errors()).toEqual([
      [
        '__error__',
        { code: 'wrong-frame-kind', detail: { event: 'upload-avatar', expected: 'binary' } },
        null,
      ],
    ]);
    expect(seen).toEqual([]);
  });

  it('answers wrong-frame-kind for a binary frame that starts a JSON stream', async () => {
    const { engine } = build(huddle([]));
    const { handle, errorCodes, texts } = await connect(engine);

    await handle.handleBinaryMessage(frame('export-room', null, { stream: { id: 's-1' } }));

    expect(errorCodes()).toEqual(['wrong-frame-kind']);
    expect(texts().some((data) => data[0] === 'export-room')).toBe(false);
  });

  it('answers wrong-frame-kind for a binary nudge, and no intercept sees it', async () => {
    const intercepted: string[] = [];
    const { engine } = build(
      huddle([], { onIntercept: (interceptFrame) => void intercepted.push(interceptFrame.kind) }),
    );
    const { handle, errors } = await connect(engine);
    void handle.handleMessage(JSON.stringify(['export-room', null, { stream: { id: 's-1' } }]));
    await new Promise((resolve) => setImmediate(resolve));

    expect(engine.core.activeStreams.has('s-1')).toBe(true);
    intercepted.length = 0;

    await handle.handleBinaryMessage(
      frame('pause-export', null, { stream: { id: 's-1', nudgeId: 'n-1' } }),
    );

    expect(errors()).toEqual([
      [
        '__error__',
        { code: 'wrong-frame-kind', detail: { event: 'pause-export', expected: 'text' } },
        { stream: { id: 's-1', nudgeId: 'n-1', terminated: false } },
      ],
    ]);
    expect(intercepted).toEqual([]);
  });

  it('answers channel-not-subscribed to a non-member, before the frame-kind check', async () => {
    const seen: Seen[] = [];
    const { engine } = build(huddle(seen));
    const { handle, errorCodes } = await connect(engine);

    await handle.handleBinaryMessage(frame('share-screen-frame', null, general));
    await handle.handleBinaryMessage(frame('rename-user', null, general));

    expect(errorCodes()).toEqual(['channel-not-subscribed', 'channel-not-subscribed']);
    expect(seen).toEqual([]);
  });

  it('answers channel-not-subscribed to a non-member that sends a binary nudge', async () => {
    const { engine } = build(huddle([]));
    const { handle, errorCodes } = await connect(engine);

    await handle.handleBinaryMessage(
      frame('pause-export', null, { ...general, stream: { id: 's-1', nudgeId: 'n-1' } }),
    );

    expect(errorCodes()).toEqual(['channel-not-subscribed']);
  });

  it('answers validation-failed for info that fails input', async () => {
    const seen: Seen[] = [];
    const { engine } = build(huddle(seen));
    const { handle, errorCodes } = await connect(engine);

    await handle.handleBinaryMessage(frame('upload-avatar', { fileType: 'image/gif' }, null));

    expect(errorCodes()).toEqual(['validation-failed']);
    expect(seen).toEqual([]);
  });

  it('answers validation-failed for bytes over maxBytes', async () => {
    const seen: Seen[] = [];
    const { engine } = build(huddle(seen));
    const { handle, errors } = await connect(engine);

    await handle.handleBinaryMessage(
      frameOf(['upload-avatar', { fileType: 'image/png' }, null], new Uint8Array(9)),
    );

    expect(errors()).toEqual([
      [
        '__error__',
        {
          code: 'validation-failed',
          detail: {
            event: 'upload-avatar',
            issues: [{ message: 'The bytes are 9 bytes, over the limit of 8 bytes.' }],
          },
        },
        null,
      ],
    ]);
    expect(seen).toEqual([]);
  });
});

describe('a binary frame in the shared pipeline', () => {
  it('shows intercepts the bytes and the size, and a returned value replaces the info', async () => {
    const frames: InterceptFrame[] = [];
    const seen: Seen[] = [];
    const { engine } = build(
      huddle(seen, {
        onIntercept(interceptFrame) {
          frames.push(interceptFrame);
          return { fileType: 'image/jpeg' };
        },
      }),
    );
    const { handle } = await connect(engine);
    const data = frame('upload-avatar', { fileType: 'image/png' }, null);

    await handle.handleBinaryMessage(data);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.kind).toBe('incoming');
    expect(frames[0]!.size).toBe(data.byteLength);
    expect([...frames[0]!.bytes!]).toEqual([...picture]);
    expect(seen[0]!.info).toEqual({ fileType: 'image/jpeg' });

    expect([...seen[0]!.bytes]).toEqual([...picture]);
  });

  it('leaves frame.bytes undefined for a text frame', async () => {
    const frames: InterceptFrame[] = [];
    const { engine } = build(huddle([], { onIntercept: (f) => void frames.push(f) }));
    const { handle } = await connect(engine);

    await handle.handleMessage(JSON.stringify(['rename-user', { name: 'Amara' }, null]));

    expect(frames[0]!.bytes).toBeUndefined();
  });

  it('teaches ctx.matches the binary handlers, for binary frames only', async () => {
    const results: boolean[] = [];
    const base = server({
      capabilities: [binary()],
      intercept(ctx, interceptFrame) {
        results.push(ctx.matches('upload-avatar', interceptFrame));
        results.push(ctx.matches('upload-avatar', { ...interceptFrame, bytes: undefined }));
      },
    });
    const handleUploadAvatar = base.binary.on('upload-avatar', {
      input: v.object({ fileType: v.string() }),
      run() {},
    });
    const { engine } = build(base.assemble({ handlers: [handleUploadAvatar] }));
    const { handle } = await connect(engine);

    await handle.handleBinaryMessage(frame('upload-avatar', { fileType: 'image/png' }, null));

    expect(results).toEqual([true, false]);
  });

  it('counts one message and its bytes in the rate limit', async () => {
    const seen: Seen[] = [];
    const base = server({
      capabilities: [binary(), rateLimit({ maxMessages: 10, maxBytes: 100, windowMs: 60_000 })],
    });
    const handleUploadAvatar = base.binary.on('upload-avatar', {
      run(_ctx, input, bytes) {
        seen.push({ info: input, bytes });
      },
    });
    const { engine } = build(base.assemble({ handlers: [handleUploadAvatar] }));
    const { handle, errorCodes } = await connect(engine);

    const data = frameOf(['upload-avatar', null, null], new Uint8Array(60));
    await handle.handleBinaryMessage(data);
    await handle.handleBinaryMessage(data);

    expect(seen).toHaveLength(1);
    expect(errorCodes()).toEqual(['rate-limited']);
  });

  it.each([
    [false, 1],
    [true, 2],
  ])('with allowInterleaving %s, runs %i frames at once', async (allowInterleaving, running) => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const base = server({ capabilities: [binary()] });
    const handleUploadAvatar = base.binary.on('upload-avatar', {
      allowInterleaving,
      async run() {
        started += 1;
        await blocked;
      },
    });

    const { engine } = build(base.assemble({ handlers: [handleUploadAvatar] }));
    const { handle } = await connect(engine);

    const sends = [
      handle.handleBinaryMessage(frame('upload-avatar', null, null)),
      handle.handleBinaryMessage(frame('upload-avatar', null, null)),
    ];
    await new Promise((resolve) => setImmediate(resolve));

    expect(started).toBe(running);
    release();
    await Promise.all(sends);
    expect(started).toBe(2);
  });

  it('drops an envelope whose event is not a string, and keeps the socket open', async () => {
    const seen: Seen[] = [];
    const { engine } = build(huddle(seen));
    const { handle, closes, sent } = await connect(engine);
    const before = sent.length;

    await handle.handleBinaryMessage(encodeBinaryFrame('[42,null,null]', picture));

    expect(closes).toEqual([]);
    expect(sent.length).toBe(before);
    expect(seen).toEqual([]);
  });

  it('checks membership, then the rate limit, then runs the intercepts, then the info', async () => {
    const intercepted: string[] = [];
    const base = server({
      capabilities: [binary(), channels(), rateLimit({ maxMessages: 100, windowMs: 60_000 })],
      intercept(_ctx, interceptFrame) {
        intercepted.push(interceptFrame.event);
      },
    });
    const rooms = base.channel(['rooms', 'room:{roomId}'], {});
    const handleShareScreenFrame = rooms.binary.on('share-screen-frame', {
      input: v.null(),
      rateLimit: { maxMessages: 1 },
      run() {},
    });
    const { engine } = build(base.assemble({ handlers: [handleShareScreenFrame] }));

    const { handle, errorCodes, subscribe } = await connect(engine);

    await handle.handleBinaryMessage(frame('share-screen-frame', { bad: true }, general));
    expect(intercepted).toEqual([]);

    await subscribe();
    intercepted.length = 0;
    await handle.handleBinaryMessage(frame('share-screen-frame', { bad: true }, general));
    await handle.handleBinaryMessage(frame('share-screen-frame', { bad: true }, general));

    expect(errorCodes()).toEqual(['channel-not-subscribed', 'validation-failed', 'rate-limited']);
    // The rate-limited frame never reaches the intercepts.
    expect(intercepted).toEqual(['share-screen-frame']);
  });

  it('drops a repeated delivery id with dedup()', async () => {
    const seen: Seen[] = [];
    const base = server({ capabilities: [binary(), dedup()] });
    const handleUploadAvatar = base.binary.on('upload-avatar', {
      run(_ctx, input, bytes) {
        seen.push({ info: input, bytes });
      },
    });
    const { engine } = build(base.assemble({ handlers: [handleUploadAvatar] }));
    const { handle } = await connect(engine);

    const data = frame('upload-avatar', null, { delivery: { id: 'm-1' } });

    await handle.handleBinaryMessage(data);
    await handle.handleBinaryMessage(data);

    expect(seen).toHaveLength(1);
  });

  it('counts every binary frame as connection activity, and only a good shape as message activity', async () => {
    const base = server({ capabilities: [binary()] });
    const handleUploadAvatar = base.binary.on('upload-avatar', { run() {} });
    const { engine } = build(base.assemble({ handlers: [handleUploadAvatar] }));
    const { handle } = await connect(engine);
    const activity: string[] = [];

    engine.core.hooks.activity.push(() => void activity.push('connection'));
    engine.core.hooks.messageActivity.push(() => void activity.push('message'));

    await handle.handleBinaryMessage(encodeBinaryFrame('not json'));
    await handle.handleBinaryMessage(frame('upload-avatar', null, null));

    expect(activity).toEqual(['connection', 'connection', 'message']);
  });

  it('waits behind a running subscribe, in the order it arrived', async () => {
    const order: string[] = [];
    let openCheck!: () => void;
    const checked = new Promise<void>((resolve) => (openCheck = resolve));
    const base = server({ capabilities: [binary(), channels()] });
    const rooms = base.channel(['rooms', 'room:{roomId}'], {
      async check() {
        await checked;
        order.push('subscribed');
      },
    });

    const handleShareScreenFrame = rooms.binary.on('share-screen-frame', {
      run() {
        order.push('frame');
      },
    });
    const { engine } = build(base.assemble({ handlers: [handleShareScreenFrame] }));
    const { handle, errorCodes } = await connect(engine);

    const subscribing = handle.handleMessage(JSON.stringify(['__subscribe__', {}, general]));
    const sending = handle.handleBinaryMessage(frame('share-screen-frame', null, general));
    openCheck();
    await Promise.all([subscribing, sending]);

    expect(order).toEqual(['subscribed', 'frame']);
    expect(errorCodes()).toEqual([]);
  });

  it('holds its bytes against the pending-bytes budget until its handler starts', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const base = server({ capabilities: [binary()] });
    const handleUploadAvatar = base.binary.on('upload-avatar', {
      async run() {
        await blocked;
      },
    });
    const { engine } = build(base.assemble({ handlers: [handleUploadAvatar] }), {
      receiveBytes: 120,
      sendBytes: 120,
    });

    const { handle, connection, errorCodes } = await connect(engine);
    const data = frameOf(['upload-avatar', null, null], new Uint8Array(70));

    // The first handler starts at once and gives its bytes back; the next two wait in line.
    const running = handle.handleBinaryMessage(data);
    await new Promise((resolve) => setImmediate(resolve));
    const waiting = [running, ...[1, 2].map(() => handle.handleBinaryMessage(data))];
    await new Promise((resolve) => setImmediate(resolve));
    expect(connection.pendingBytes).toBe(2 * data.byteLength);

    await handle.handleBinaryMessage(data);

    expect(errorCodes()).toEqual(['connection-busy']);
    release();
    await Promise.all(waiting);
    expect(connection.pendingBytes).toBe(0);
  });

  it.each(['text', 'binary'] as const)(
    'counts a %s frame that says it answers the server, but matches no waiting request',
    async (kind) => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      const base = server({ capabilities: [binary()] });
      const handleUploadAvatar = base.binary.on('upload-avatar', {
        async run() {
          await blocked;
        },
      });
      const handleRenameUser = base.on('rename-user', {
        async run() {
          await blocked;
        },
      });

      const { engine } = build(base.assemble({ handlers: [handleUploadAvatar, handleRenameUser] }));
      const { handle, connection } = await connect(engine);
      const answer = { exchange: { id: 'r-1', source: 'server' } };
      function send(): Promise<void> {
        return kind === 'text'
          ? handle.handleMessage(JSON.stringify(['rename-user', null, answer]))
          : handle.handleBinaryMessage(frame('upload-avatar', null, answer));
      }

      const running = send();
      await new Promise((resolve) => setImmediate(resolve));
      const waiting = send();
      await new Promise((resolve) => setImmediate(resolve));

      expect(connection.pendingBytes).toBeGreaterThan(0);
      release();
      await Promise.all([running, waiting]);
      expect(connection.pendingBytes).toBe(0);
    },
  );
});

describe('maxBytes at startup', () => {
  it('fails to start when a binary handler maxBytes cannot fit in receiveBytes', async () => {
    const base = server({ capabilities: [binary()] });
    const handleUploadAvatar = base.binary.on('upload-avatar', { maxBytes: 1001, run() {} });
    const { engine } = build(base.assemble({ handlers: [handleUploadAvatar] }), {
      receiveBytes: 9 + 64 * 1024 + 1000,
      sendBytes: 1000,
    });

    await expect(engine.initialize()).rejects.toThrow(
      /binary\.on\('upload-avatar'\): maxBytes 1001 does not fit.*Use 1000 or less/s,
    );
  });

  it('fails to start when maxBytes leaves no room for a 64 KiB envelope', async () => {
    const base = server({ capabilities: [binary()] });
    const handleUploadAvatar = base.binary.on('upload-avatar', { maxBytes: 950, run() {} });
    const { engine } = build(base.assemble({ handlers: [handleUploadAvatar] }), {
      receiveBytes: 1000,
      sendBytes: 1000,
    });

    await expect(engine.initialize()).rejects.toThrow(
      /under 64 KiB plus the 9-byte header.*raise the adapter's message limit above 65545 bytes/s,
    );
  });

  it('starts when maxBytes fits with the header and a 64 KiB envelope', async () => {
    const base = server({ capabilities: [binary()] });
    const handleUploadAvatar = base.binary.on('upload-avatar', { maxBytes: 1000, run() {} });
    const { engine } = build(base.assemble({ handlers: [handleUploadAvatar] }), {
      receiveBytes: 9 + 64 * 1024 + 1000,
      sendBytes: 1000,
    });

    await expect(engine.initialize()).resolves.toBeUndefined();
  });

  it('limits the bytes by default to what fits with the header and a 64 KiB envelope', async () => {
    const seen: Seen[] = [];
    const base = server({ capabilities: [binary()] });
    const handleUploadAvatar = base.binary.on('upload-avatar', {
      run(_ctx, input, bytes) {
        seen.push({ info: input, bytes });
      },
    });
    const { engine } = build(base.assemble({ handlers: [handleUploadAvatar] }), {
      receiveBytes: 9 + 64 * 1024 + 10,
      sendBytes: 1000,
    });
    const { handle, errorCodes } = await connect(engine);

    await handle.handleBinaryMessage(frameOf(['upload-avatar', null, null], new Uint8Array(10)));
    await handle.handleBinaryMessage(frameOf(['upload-avatar', null, null], new Uint8Array(11)));

    expect(seen.map((entry) => entry.bytes.byteLength)).toEqual([10]);
    expect(errorCodes()).toEqual(['validation-failed']);
  });
});
