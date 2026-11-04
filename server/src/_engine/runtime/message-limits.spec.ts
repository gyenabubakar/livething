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
import { describe, expect, it, vi } from 'vitest';
import type { EngineRuntimeOptions } from '~/_adapters/types.ts';
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

async function connect(engine: Engine) {
  await engine.initialize();
  const sent: string[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const handle = engine.accept(Symbol('ama'), {
    send: (data: string) => sent.push(data),
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
    bufferedAmount: () => 0,
    userId: 'ama',
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
