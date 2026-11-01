import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { emits } from '~/emits/emits.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

async function startEngine(definition: Parameters<ReturnType<typeof adapter>>[0]): Promise<Engine> {
  let engine!: Engine;
  adapter({
    id: 'server-hooks-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  })(definition, undefined as never);
  await engine.initialize();
  return engine;
}

async function connect(engine: Engine) {
  const sent: unknown[][] = [];
  const handle = engine.accept(Symbol('ama'), {
    send: (data: string) => sent.push(JSON.parse(data) as unknown[]),
    close: () => {},
    bufferedAmount: () => 0,
    userId: 'ama',
  });
  await [...engine.core.connections.values()].at(-1)?.lifecycleReady;
  return { handle, sent };
}

describe('hooks written in server({ ... })', () => {
  it('runs every hook', async () => {
    const calls: string[] = [];
    function record(name: string) {
      return () => {
        calls.push(name);
      };
    }

    const base = server({
      capabilities: [emits({ pong: t<{ text: string }>() })],
      onInit: record('onInit'),
      onConnect: record('onConnect'),
      onDisconnect: record('onDisconnect'),
      onPing: record('onPing'),
      onPong: record('onPong'),
      onError: record('onError'),
      onShutdown: record('onShutdown'),
      intercept: record('intercept'),
      onOutgoing: record('onOutgoing'),
    });
    const handleSay = base.on('say', {
      input: v.object({}),
      run(ctx) {
        ctx.send('pong', { text: 'hi' });
      },
    });
    const handleFail = base.on('fail', {
      input: v.object({}),
      run() {
        throw new Error('boom');
      },
    });

    const engine = await startEngine(base.assemble({ handlers: [handleSay, handleFail] }));
    expect(calls).toEqual(['onInit']);

    const { handle } = await connect(engine);
    expect(calls).toContain('onConnect');

    await handle.handleMessage('ping');
    expect(calls).toContain('onPing');
    await handle.handleMessage('pong');
    expect(calls).toContain('onPong');

    await handle.handleMessage(JSON.stringify(['say', {}, null]));
    expect(calls).toContain('intercept');
    expect(calls).toContain('onOutgoing');

    await handle.handleMessage(JSON.stringify(['fail', {}, null]));
    expect(calls).toContain('onError');

    await handle.handleClose(1000, 'bye');
    expect(calls).toContain('onDisconnect');

    await engine.handleShutdown();
    expect(calls).toContain('onShutdown');
  });

  it('passes each hook its ctx and frame', async () => {
    const seen: Record<string, unknown> = {};
    function userOf(ctx: { connection: { userId: string } }) {
      return ctx.connection.userId;
    }

    const base = server({
      capabilities: [emits({ pong: t<{ text: string }>() })],
      onConnect(ctx) {
        seen.onConnect = userOf(ctx);
      },
      onDisconnect(ctx) {
        seen.onDisconnect = userOf(ctx);
      },
      onPing(ctx) {
        seen.onPing = userOf(ctx);
      },
      onPong(ctx) {
        seen.onPong = userOf(ctx);
      },
      onError(ctx, error, event) {
        seen.onError = { user: userOf(ctx), message: (error as Error).message, event };
      },
      intercept(ctx, frame) {
        seen.intercept = { user: userOf(ctx), frame };
      },
      onOutgoing(ctx, frame) {
        seen.onOutgoing = { user: ctx && userOf(ctx), frame };
      },
    });
    const handleSay = base.on('say', {
      input: v.object({}),
      run(ctx) {
        ctx.send('pong', { text: 'hi' });
      },
    });
    const handleFail = base.on('fail', {
      input: v.object({}),
      run() {
        throw new Error('boom');
      },
    });

    const engine = await startEngine(base.assemble({ handlers: [handleSay, handleFail] }));
    const { handle } = await connect(engine);
    const connectionId = [...engine.core.connections.keys()].at(-1);
    await handle.handleMessage('ping');
    await handle.handleMessage('pong');

    await handle.handleMessage(JSON.stringify(['say', {}, null]));

    expect(seen.intercept).toEqual({
      user: 'ama',
      frame: expect.objectContaining({
        event: 'say',
        payload: {},
        kind: 'incoming',
        owner: { kind: 'app' },
      }),
    });
    expect(seen.onOutgoing).toEqual({
      user: 'ama',
      frame: {
        event: 'pong',
        payload: { text: 'hi' },
        owner: { kind: 'app' },
        channel: null,
        target: { kind: 'connection', id: connectionId },
        recipients: 1,
      },
    });

    await handle.handleMessage(JSON.stringify(['fail', {}, null]));
    await handle.handleClose(1000, 'bye');

    expect(seen).toMatchObject({
      onConnect: 'ama',
      onPing: 'ama',
      onPong: 'ama',
      onError: { user: 'ama', message: 'boom', event: 'fail' },
      onDisconnect: 'ama',
    });
  });

  it('gives a hook the same ctx a handler gets', async () => {
    const base = server({
      upgrade: () => ({ userId: 'ama', meta: { name: 'Ama' } }),
      capabilities: [emits({ welcome: t<{ name: string }>() })],
      onConnect(ctx) {
        ctx.send('welcome', { name: ctx.meta.name });
      },
    });
    const engine = await startEngine(base.assemble({ handlers: [] }));

    const meta = { name: 'Ama' };
    const sent: unknown[][] = [];
    const handle = engine.accept(Symbol('ama'), {
      send: (data: string) => sent.push(JSON.parse(data) as unknown[]),
      close: () => {},
      bufferedAmount: () => 0,
      userId: 'ama',
      meta,
    });
    await [...engine.core.connections.values()].at(-1)?.lifecycleReady;

    expect(sent.find((frame) => frame[0] === 'welcome')?.[1]).toEqual({ name: 'Ama' });
    await handle.handleClose(1000, 'bye');
  });

  it('includes the same hooks in every definition assembled from one base', () => {
    const base = server({ onConnect() {} });

    function hookCount(definition: { primitives: readonly { __livething: string }[] }) {
      return definition.primitives.filter((p) => p.__livething === 'onConnect').length;
    }

    expect(hookCount(base.assemble({ handlers: [] }))).toBe(1);
    expect(hookCount(base.assemble({ handlers: [] }))).toBe(1);
  });

  it('has no method to register a hook after server() returns', () => {
    const base = server({}) as unknown as Record<string, unknown>;
    for (const hook of [
      'onInit',
      'onConnect',
      'onDisconnect',
      'onPing',
      'onPong',
      'onError',
      'onShutdown',
      'intercept',
      'onOutgoing',
    ]) {
      expect(base[hook]).toBeUndefined();
    }
  });
});
