/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { keepalive } from '~/keepalive/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { plugin } from './plugins.ts';

function makeStorage() {
  const sql = {
    exec() {
      return { toArray: () => [], one: () => null, raw: () => [] };
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
  };

  return { sql, kv: { get() {}, put() {}, delete() {}, list: () => [] } } as any;
}

function buildEngine(definition: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'plugin-heartbeat',
    hibernation: { persist() {}, restore: () => undefined },
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: makeStorage(),

        platform: {},
        timers: { setAlarm() {}, deleteAlarm() {} } as never,
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  runAdapter(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return captured;
}

async function openConnection(engine: Engine) {
  await engine.initialize();
  const conn = engine.accept(Symbol('ws'), {
    send() {},
    close() {},
    bufferedAmount: () => 0,
    userId: 'user-1',
  } as any);
  await Promise.resolve();
  return conn;
}

describe('plugin onPing / onPong', () => {
  it('a plugin can register onPing / onPong', async () => {
    const seen: string[] = [];
    const ph = server({
      scope: 'plugin',
      onPing: () => void seen.push('ping'),
      onPong: () => void seen.push('pong'),
    });
    const beat = ph.on('beat', { input: v.object({}), run() {} });

    const Probe = plugin('acme:probe', { definition: ph.assemble({ handlers: [beat] }) });

    const base = server({ capabilities: [Probe()] });
    const conn = await openConnection(buildEngine(base.assemble({ handlers: [] })));

    await conn.handleMessage('ping');
    await conn.handleMessage('pong');

    expect(seen).toEqual(['ping', 'pong']);
  });

  it('the plugin observer sees its own scoped ctx', async () => {
    let scopedId: unknown;
    const ph = server({
      scope: 'plugin',
      onPong: (ctx: any) => void (scopedId = ctx.connection.id),
    });
    const beat = ph.on('beat', { input: v.object({}), run() {} });
    const Probe = plugin('acme:probe', { definition: ph.assemble({ handlers: [beat] }) });

    const base = server({ capabilities: [Probe()] });
    const conn = await openConnection(buildEngine(base.assemble({ handlers: [] })));

    await conn.handleMessage('pong');

    expect(typeof scopedId).toBe('string');
  });

  it('runs a pong through plugin observers before the app, after keepalive', async () => {
    const order: string[] = [];
    const ph = server({ scope: 'plugin', onPong: () => void order.push('plugin') });
    const beat = ph.on('beat', { input: v.object({}), run() {} });
    const Probe = plugin('acme:probe', { definition: ph.assemble({ handlers: [beat] }) });

    const base = server({
      capabilities: [keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 }), Probe()],
      onPong: () => void order.push('app'),
    });
    const conn = await openConnection(buildEngine(base.assemble({ handlers: [] })));

    await conn.handleMessage('pong');

    // keepalive() (a capability) records on `pong` before either observer runs;
    // the plugin then runs before the app.
    expect(order).toEqual(['plugin', 'app']);
  });

  it('isolates a throwing plugin observer so the app still runs', async () => {
    const order: string[] = [];
    const ph = server({
      scope: 'plugin',
      onPing() {
        throw new Error('plugin ping hook failed');
      },
    });
    const beat = ph.on('beat', { input: v.object({}), run() {} });
    const Probe = plugin('acme:probe', { definition: ph.assemble({ handlers: [beat] }) });

    const base = server({ capabilities: [Probe()], onPing: () => void order.push('app') });
    const conn = await openConnection(buildEngine(base.assemble({ handlers: [] })));

    await conn.handleMessage('ping');

    expect(order).toEqual(['app']);
  });
});
