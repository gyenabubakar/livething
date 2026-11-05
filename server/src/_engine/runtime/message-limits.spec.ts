import { AsyncLocalStorage } from 'node:async_hooks';
import { CloseCodes } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { sendReplay } from '~/_engine/runtime/wire.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineRuntimeOptions, TransportFrame } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function build(
  definition: ServerDefinition,
  messageLimits?: EngineRuntimeOptions['messageLimits'],
): { engine: Engine; errors: unknown[][] } {
  const errors: unknown[][] = [];
  let engine!: Engine;
  adapter({
    id: 'message-limits-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: (...args: unknown[]) => errors.push(args) },
        ...(messageLimits ? { messageLimits } : {}),
      });
      return {};
    },
  })(definition, undefined as never);
  return { engine, errors };
}

function frameText(frame: TransportFrame): string {
  if (frame.kind !== 'text') throw new Error('expected a text frame');

  return frame.text;
}

async function connect(engine: Engine, userId = 'ama', buffered = () => 0) {
  await engine.initialize();
  const sent: string[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const handle = engine.accept(Symbol(userId), {
    send: (frame: TransportFrame) => sent.push(frameText(frame)),
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
    bufferedAmount: buffered,
    backpressureSupported: true,
    userId,
  });
  await [...engine.core.connections.values()].at(-1)!.lifecycleReady;

  return { handle, sent, closes };
}

describe('the receive limit', () => {
  function postServer(posts: string[]) {
    const base = server({});
    const post = base.on('post-message', {
      input: v.object({ text: v.string() }),
      run(_ctx, input) {
        posts.push(input.text);
      },
    });
    return base.assemble({ handlers: [post] });
  }

  it('closes the socket with 1009 for a message over receiveBytes, counted in UTF-8 bytes', async () => {
    const posts: string[] = [];
    const { engine } = build(postServer(posts), { receiveBytes: 100, sendBytes: 100 });
    const { handle, closes } = await connect(engine);

    // 40 'é' are 40 UTF-16 units but 80 UTF-8 bytes, so the frame is over 100 bytes.
    await handle.handleMessage(JSON.stringify(['post-message', { text: 'é'.repeat(40) }, null]));

    expect(closes).toEqual([{ code: CloseCodes.MESSAGE_TOO_BIG, reason: 'Message is too big' }]);
    expect(posts).toEqual([]);
  });

  it('runs no handler for a frame that arrives while the 1009 close completes', async () => {
    const posts: string[] = [];
    const { engine } = build(postServer(posts), { receiveBytes: 100, sendBytes: 100 });
    const { handle } = await connect(engine);

    await handle.handleMessage(JSON.stringify(['post-message', { text: 'x'.repeat(200) }, null]));
    await handle.handleMessage(JSON.stringify(['post-message', { text: 'small' }, null]));

    expect(posts).toEqual([]);
  });

  it('lets a message of exactly receiveBytes through', async () => {
    const posts: string[] = [];
    const { engine } = build(postServer(posts), { receiveBytes: 100, sendBytes: 100 });
    const { handle, closes } = await connect(engine);
    const empty = JSON.stringify(['post-message', { text: '' }, null]);
    const text = 'x'.repeat(100 - empty.length);

    await handle.handleMessage(JSON.stringify(['post-message', { text }, null]));

    expect(closes).toEqual([]);
    expect(posts).toEqual([text]);
  });

  it('defaults to 32 MiB', async () => {
    const posts: string[] = [];
    const { engine } = build(postServer(posts));
    const { handle, closes } = await connect(engine);

    await handle.handleMessage(
      JSON.stringify(['post-message', { text: 'x'.repeat(32 * 1024 * 1024) }, null]),
    );

    expect(closes.map((close) => close.code)).toEqual([CloseCodes.MESSAGE_TOO_BIG]);
  });
});

describe('a binary message', () => {
  function postServer(posts: string[]) {
    const base = server({});
    const post = base.on('post-message', {
      input: v.object({ text: v.string() }),
      run(_ctx, input) {
        posts.push(input.text);
      },
    });
    return base.assemble({ handlers: [post] });
  }

  it('closes the socket with 1009 when it is over receiveBytes', async () => {
    const { engine } = build(postServer([]), { receiveBytes: 100, sendBytes: 100 });
    const { handle, closes } = await connect(engine);

    await handle.handleBinaryMessage(new Uint8Array(101));

    expect(closes).toEqual([{ code: CloseCodes.MESSAGE_TOO_BIG, reason: 'Message is too big' }]);
  });

  it('closes the socket with 1003 while no capability takes binary frames', async () => {
    const { engine } = build(postServer([]), { receiveBytes: 100, sendBytes: 100 });
    const { handle, closes } = await connect(engine);

    await handle.handleBinaryMessage(new Uint8Array(100));

    expect(closes).toEqual([
      {
        code: CloseCodes.UNSUPPORTED_DATA,
        reason: '[livething] this server does not use binary()',
      },
    ]);
  });

  it.each([10, 1000])(
    'runs no handler for a frame that arrives while the close for %i bytes completes',
    async (size) => {
      const posts: string[] = [];
      const { engine } = build(postServer(posts), { receiveBytes: 100, sendBytes: 100 });
      const { handle, closes } = await connect(engine);

      await handle.handleBinaryMessage(new Uint8Array(size));
      await handle.handleBinaryMessage(new Uint8Array(10));
      await handle.handleMessage(JSON.stringify(['post-message', { text: 'small' }, null]));

      expect(posts).toEqual([]);
      expect(closes).toHaveLength(1);
    },
  );
});

describe('the send limit', () => {
  it('throws instead of sending a message over sendBytes', async () => {
    const base = server({ capabilities: [emits({ 'history-loaded': t<{ text: string }>() })] });
    const outcomes: string[] = [];
    const load = base.on('load-history', {
      run(ctx) {
        try {
          ctx.send('history-loaded', { text: 'x'.repeat(200) });
          outcomes.push('sent');
        } catch (error) {
          outcomes.push((error as Error).message);
        }
      },
    });
    const { engine } = build(base.assemble({ handlers: [load] }), {
      receiveBytes: 1000,
      sendBytes: 100,
    });
    const { handle, sent } = await connect(engine);

    await handle.handleMessage(JSON.stringify(['load-history', null, null]));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatch(/over the send limit of 100 bytes/);
    expect(sent.some((data) => data.includes('history-loaded'))).toBe(false);
  });
});

describe('a member whose socket buffer is over twice sendBytes', () => {
  function chatServer(disconnects: (number | undefined)[] = []) {
    const base = server({
      capabilities: [emits({ 'message-posted': t<{ text: string }>() })],
      onDisconnect(ctx) {
        disconnects.push(ctx.closeCode);
      },
    });
    const handlePost = base.on('post-message', {
      input: v.object({ text: v.string() }),
      run(ctx, input) {
        ctx.broadcast('message-posted', { text: input.text });
      },
    });
    return base.assemble({ handlers: [handlePost] });
  }

  function posted(sent: string[]): string[] {
    return sent.filter((data) => data.includes('message-posted'));
  }

  async function post(engine: Engine, text: string): Promise<void> {
    const { handle } = await connect(engine, 'ama');
    await handle.handleMessage(JSON.stringify(['post-message', { text }, null]));
  }

  let skew = 0;

  // The check reads the monotonic clock, so the tests move `performance.now()` on.
  beforeEach(() => {
    skew = 0;
    const realNow = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skew);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function later(ms: number): void {
    skew += ms;
  }

  it('is closed with 1013 once its buffer stayed over the limit for 10 seconds, and the others still get the broadcast', async () => {
    const { engine } = build(chatServer(), { receiveBytes: 1000, sendBytes: 1000 });
    const kofi = await connect(engine, 'kofi', () => 2001);
    const amara = await connect(engine, 'amara');

    await post(engine, 'hi');
    later(10_001);
    await post(engine, 'again');
    await post(engine, 'third');

    expect(posted(kofi.sent)).toHaveLength(1);
    expect(kofi.closes).toEqual([
      { code: CloseCodes.TRY_AGAIN_LATER, reason: expect.stringMatching(/^\[livething\] /) },
    ]);
    expect(posted(amara.sent)).toHaveLength(3);
    expect(amara.closes).toEqual([]);
  });

  it('is not closed while its buffer has been over the limit for less than 10 seconds', async () => {
    const { engine } = build(chatServer(), { receiveBytes: 1000, sendBytes: 1000 });
    const kofi = await connect(engine, 'kofi', () => 1_000_000);

    await post(engine, 'hi');
    later(9_999);
    await post(engine, 'again');

    expect(posted(kofi.sent)).toHaveLength(2);
    expect(kofi.closes).toEqual([]);
  });

  it('runs no handler for a frame that arrives after the 1013 close', async () => {
    const { engine } = build(chatServer(), { receiveBytes: 1000, sendBytes: 1000 });
    const kofi = await connect(engine, 'kofi', () => 2001);
    const amara = await connect(engine, 'amara');
    await post(engine, 'hi');
    later(10_001);

    await post(engine, 'again');

    await kofi.handle.handleMessage(JSON.stringify(['post-message', { text: 'late' }, null]));

    expect(kofi.closes.map((close) => close.code)).toEqual([CloseCodes.TRY_AGAIN_LATER]);
    expect(posted(amara.sent)).toHaveLength(2);
  });

  it('is still sent to when the buffer is exactly twice sendBytes', async () => {
    const { engine } = build(chatServer(), { receiveBytes: 1000, sendBytes: 1000 });
    const kofi = await connect(engine, 'kofi', () => 2000);

    await post(engine, 'hi');

    expect(posted(kofi.sent)).toHaveLength(1);
    expect(kofi.closes).toEqual([]);
  });

  it('is never closed when its platform does not report buffer pressure', async () => {
    const { engine } = build(chatServer(), { receiveBytes: 1000, sendBytes: 1000 });
    await engine.initialize();
    const sent: string[] = [];
    const closes: unknown[] = [];
    engine.accept(Symbol('kofi'), {
      send: (frame: TransportFrame) => sent.push(frameText(frame)),
      close: (code?: number) => closes.push(code),
      bufferedAmount: () => 1_000_000,
      userId: 'kofi',
    });

    await [...engine.core.connections.values()].at(-1)!.lifecycleReady;

    await post(engine, 'hi');

    expect(posted(sent)).toHaveLength(1);
    expect(closes).toEqual([]);
  });
});

describe('the slow-member check during a burst of sends', () => {
  function row(seq: number) {
    return {
      channelName: null,
      channelFamily: null,
      event: 'message-posted',
      payload: { text: 'x'.repeat(60) },
      wire: { deliverySeq: seq, messageId: `m${seq}` },
    };
  }

  // A socket that never drains: everything written stays in its buffer.
  async function stalledClient(engine: Engine) {
    // `client` is set once `connect` returns; the engine may read the buffer before that.
    const client: Awaited<ReturnType<typeof connect>> = await connect(
      engine,
      'kofi',
      () => client?.sent.join('').length ?? 0,
    );
    const connection = [...engine.core.connections.values()].at(-1)!;

    return { ...client, connection };
  }

  it('delivers a long replay far over the limit, and the sends on the next turn too', async () => {
    const { engine } = build(server({}).assemble({ handlers: [] }), {
      receiveBytes: 1000,
      sendBytes: 1000,
    });
    const kofi = await stalledClient(engine);

    for (let seq = 1; seq <= 40; seq += 1) sendReplay(engine.core, kofi.connection, row(seq));
    await macrotask();
    sendReplay(engine.core, kofi.connection, row(41));

    expect(kofi.sent.filter((data) => data.includes('message-posted'))).toHaveLength(41);
    expect(kofi.closes).toEqual([]);
  });
});

describe('a slow member that does not read the 1013 close', () => {
  it('is terminated after one second, and its close cleanup runs once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const disconnects: (number | undefined)[] = [];
      const base = server({
        capabilities: [emits({ 'message-posted': t<{ text: string }>() })],
        onDisconnect(ctx) {
          disconnects.push(ctx.closeCode);
        },
      });
      const { engine } = build(base.assemble({ handlers: [] }), {
        receiveBytes: 1000,
        sendBytes: 1000,
      });
      await engine.initialize();
      const terminate = vi.fn();

      const handle = engine.accept(Symbol('kofi'), {
        send: () => true,
        close: () => {},
        terminate,
        bufferedAmount: () => 5000,
        backpressureSupported: true,
        userId: 'kofi',
      });
      const connection = [...engine.core.connections.values()].at(-1)!;
      await connection.lifecycleReady;

      expect(connection.descriptor.send({ kind: 'text', text: 'hi' })).toBe(true);
      vi.advanceTimersByTime(10_001);
      expect(connection.descriptor.send({ kind: 'text', text: 'hi' })).toBe(false);
      vi.advanceTimersByTime(999);
      expect(terminate).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(terminate).toHaveBeenCalledTimes(1);

      // The platform may report both the drop and the graceful close.
      await Promise.all([handle.handleClose(1006, ''), handle.handleClose(1013, '')]);

      expect(disconnects).toEqual([1006]);
      expect(engine.core.connections.has(connection.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a stored row over the send limit', () => {
  it('is replaced by an __error__ frame, so the rows after it are still sent', async () => {
    const { engine } = build(server({}).assemble({ handlers: [] }), {
      receiveBytes: 1000,
      sendBytes: 300,
    });
    const { sent } = await connect(engine);
    const connection = [...engine.core.connections.values()].at(-1)!;
    function row(text: string, seq: number) {
      return {
        channelName: null,
        channelFamily: null,
        event: 'message-posted',
        payload: { text },
        wire: { deliverySeq: seq, messageId: `m${seq}` },
      };
    }

    sendReplay(engine.core, connection, row('x'.repeat(500), 1));
    sendReplay(engine.core, connection, row('small', 2));

    const frames = sent.map((data) => JSON.parse(data) as [string, unknown, unknown]);
    expect(frames.map(([event]) => event).slice(-2)).toEqual(['__error__', 'message-posted']);
    expect(frames.at(-2)?.[2]).toMatchObject({ delivery: { seq: 1, id: 'm1' } });
  });
});

describe('the bytes a connection holds before its handlers start', () => {
  it('are limited to twice receiveBytes', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const base = server({ capabilities: [channels()] });
    const files = base.channel('files', {
      async check() {
        await gate;
      },
    });
    const upload = files.on('upload-file', { input: v.unknown(), run() {} });

    const { engine } = build(base.assemble({ handlers: [files, upload] }), {
      receiveBytes: 1000,
      sendBytes: 1000,
    });
    const { handle, sent } = await connect(engine);
    const inFiles = { channel: { name: 'files' } };
    const frame = JSON.stringify(['upload-file', { data: 'x'.repeat(900) }, inFiles]);

    const running = [
      handle.handleMessage(JSON.stringify(['__subscribe__', null, inFiles])),
      handle.handleMessage(frame),
      handle.handleMessage(frame),
      handle.handleMessage(frame),
    ];
    await macrotask();

    expect(sent.filter((data) => data.includes('"connection-busy"'))).toHaveLength(1);
    open();
    await Promise.all(running);
  });
});

describe('messageLimits', () => {
  it('throws at startup when a limit is not a positive whole number', () => {
    for (const receiveBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        build(server({}).assemble({ handlers: [] }), { receiveBytes, sendBytes: 100 }),
      ).toThrow(/messageLimits\.receiveBytes/);
    }
  });
});
