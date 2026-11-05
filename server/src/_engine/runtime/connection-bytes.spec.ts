import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

// The budget is twice the receive limit: 2 MiB here. Two of these frames fit, three do not.
const RECEIVE_BYTES = 1024 * 1024;
const BUDGET = 2 * RECEIVE_BYTES;
const big = 'x'.repeat(700 * 1024);

function deferred() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function start(definition: ServerDefinition) {
  let engine!: Engine;
  adapter({
    id: 'connection-bytes-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        messageLimits: { receiveBytes: RECEIVE_BYTES, sendBytes: RECEIVE_BYTES },
      });
      return {};
    },
  })(definition, undefined as never);
  await engine.initialize();

  const sent: unknown[][] = [];
  const raw: string[] = [];
  const handle = engine.accept(Symbol('ama'), {
    send: ({ text: data }: { kind: 'text'; text: string }) => {
      raw.push(data);
      if (data !== 'pong') sent.push(JSON.parse(data) as unknown[]);
    },
    close: () => {},
    bufferedAmount: () => 0,
    userId: 'ama',
  });
  await [...engine.core.connections.values()].at(-1)!.lifecycleReady;

  function busy(): number {
    return sent.filter(
      ([event, payload]) =>
        event === '__error__' && (payload as { code?: string }).code === 'connection-busy',
    ).length;
  }

  return { handle, sent, raw, busy };
}

describe('the bytes one connection holds before its handlers start', () => {
  it('refuse a frame held behind a pending subscribe once they go over the budget', async () => {
    const { gate, open } = deferred();
    const base = server({ capabilities: [channels()] });
    const files = base.channel('files', {
      async check() {
        await gate;
      },
    });
    const uploads: number[] = [];
    const upload = files.on('upload-file', {
      input: v.object({ data: v.string() }),
      run(_ctx, input) {
        uploads.push(input.data.length);
      },
    });

    const { handle, busy } = await start(base.assemble({ handlers: [files, upload] }));
    const inFiles = { channel: { name: 'files' } };
    const frame = JSON.stringify(['upload-file', { data: big }, inFiles]);

    const subscribing = handle.handleMessage(JSON.stringify(['__subscribe__', null, inFiles]));
    const frames = [1, 2, 3].map(() => handle.handleMessage(frame));
    await macrotask();

    expect(busy()).toBe(1);
    open();
    await Promise.all([subscribing, ...frames]);
    expect(uploads).toHaveLength(2);
  });

  it('refuse a frame that would wait in the work queue once they go over the budget', async () => {
    const { gate, open } = deferred();
    const base = server({});
    const uploads: number[] = [];
    const upload = base.on('upload-file', {
      input: v.object({ data: v.string() }),
      async run(_ctx, input) {
        uploads.push(input.data.length);
        await gate;
      },
    });
    const { handle, busy } = await start(base.assemble({ handlers: [upload] }));

    const frame = JSON.stringify(['upload-file', { data: big }, null]);

    // The first handler starts and gives its bytes back; the next ones wait for its turn.
    const running = handle.handleMessage(frame);
    await macrotask();
    const waiting = [1, 2, 3].map(() => handle.handleMessage(frame));
    await macrotask();

    expect(busy()).toBe(1);
    open();
    await Promise.all([running, ...waiting]);
    expect(uploads).toHaveLength(3);
  });

  it('are given back when a handler starts, not when it returns', async () => {
    const { gate, open } = deferred();
    const base = server({ capabilities: [clientRequests()] });
    const upload = base.request('upload-file', {
      input: v.object({ data: v.string() }),
      async run() {
        await gate;
        return { ok: true };
      },
    });
    const { handle, busy } = await start(base.assemble({ handlers: [upload] }));
    const frames = [1, 2, 3, 4].map((n) =>
      JSON.stringify(['upload-file', { data: big }, { exchange: { id: `r${n}` } }]),
    );

    const running: Promise<void>[] = [];
    for (const frame of frames) {
      running.push(handle.handleMessage(frame));
      await macrotask();
    }

    expect(busy()).toBe(0);
    open();
    await Promise.all(running);
  });

  it('never refuse ping, control frames or answers, which do not wait in line', async () => {
    const { gate, open } = deferred();
    const base = server({ capabilities: [channels()] });
    const files = base.channel('files', {
      async check() {
        await gate;
      },
    });
    const upload = files.on('upload-file', { input: v.unknown(), run() {} });
    const { handle, sent, raw, busy } = await start(base.assemble({ handlers: [files, upload] }));

    const inFiles = { channel: { name: 'files' } };
    // Two frames fill the budget to 3 bytes short, so not even a ping would fit.
    const subscribe = JSON.stringify(['__subscribe__', null, inFiles]);
    const overhead = JSON.stringify(['upload-file', { data: '' }, inFiles]).length;
    const first = Math.floor((BUDGET - subscribe.length - 3) / 2);
    const second = BUDGET - subscribe.length - 3 - first;
    function fill(size: number): string {
      return JSON.stringify(['upload-file', { data: 'x'.repeat(size - overhead) }, inFiles]);
    }

    const subscribing = handle.handleMessage(subscribe);
    const held = [handle.handleMessage(fill(first)), handle.handleMessage(fill(second))];
    await macrotask();

    await handle.handleMessage('ping');
    await handle.handleMessage(
      JSON.stringify(['confirm-leave', { ok: true }, { exchange: { id: 'q1', source: 'server' } }]),
    );
    expect(raw).toContain('pong');
    expect(busy()).toBe(0);

    await handle.handleMessage(
      JSON.stringify(['upload-file', { data: 'y'.repeat(400) }, { exchange: { id: 'r1' } }]),
    );
    const refusal = sent.find(
      ([event, payload]) =>
        event === '__error__' && (payload as { code?: string }).code === 'connection-busy',
    );
    expect(refusal?.[2]).toMatchObject({ exchange: { id: 'r1' } });

    await handle.handleMessage(
      JSON.stringify([
        '__unsubscribe__',
        null,
        { channel: { name: 'files', unsubscribeId: 'u1' } },
      ]),
    );
    expect(busy()).toBe(1);

    open();
    await Promise.all([subscribing, ...held]);
  });

  it('are given back for a frame that never reaches a handler', async () => {
    const { handle, busy } = await start(server({}).assemble({ handlers: [] }));
    const frame = JSON.stringify(['no-such-event', { data: big }, null]);

    for (let i = 0; i < 4; i++) await handle.handleMessage(frame);

    expect(busy()).toBe(0);
  });
});
