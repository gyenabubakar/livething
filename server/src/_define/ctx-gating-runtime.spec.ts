/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { define } from '~/_define/define.ts';
import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
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
    transaction<T>(fn: (tx: any) => T): T {
      return fn(sql);
    },
  };

  return { sql, kv: { get() {}, put() {}, delete() {}, list: () => [] } } as any;
}

function buildEngine(handler: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const server = adapter({
    id: 'ctx-gating-runtime',
    hibernation: { persist() {}, restore: () => undefined },
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: makeStorage(),

        platform: {},
        timers: { setAlarm() {}, getAlarm: () => null, deleteAlarm() {} } as never,
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  server(handler, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return captured;
}

interface ProbeServer {
  def: ServerDefinition;
  slot: { fn?: (ctx: any) => void };
}

/** Build a server whose `probe` handler hands its live ctx back to the test. */
function probeServer(base: any, ...extra: unknown[]): ProbeServer {
  const slot: { fn?: (ctx: any) => void } = {};
  const probe = base.on('probe', {
    input: v.object({}),
    run(ctx: any) {
      slot.fn?.(ctx);
    },
  });
  return { def: base.assemble({ handlers: [probe, ...extra] }) as ServerDefinition, slot };
}

/** Boot the engine, open one connection, route a `probe` frame, return its ctx. */
async function captureCtx(server: ProbeServer): Promise<any> {
  const engine = buildEngine(server.def);
  await engine.initialize();
  const conn = engine.accept(Symbol('ws'), {
    send() {},
    close() {},
    bufferedAmount: () => 0,
    userId: 'user-1',
  } as any);
  let captured: any;
  server.slot.fn = (ctx: any) => {
    captured = ctx;
  };

  await conn.handleMessage(JSON.stringify({ event: 'probe', payload: {} }));
  if (!captured) throw new Error('probe handler did not run');

  return captured;
}

describe('capability-owned ctx surfaces — runtime gating', () => {
  it('a bare server exposes none of the gated surfaces', async () => {
    const ctx = await captureCtx(probeServer(define({})));
    expect('schedule' in ctx).toBe(false);
    expect('cancelScheduled' in ctx).toBe(false);
    expect('latency' in ctx).toBe(false);
    expect('quality' in ctx).toBe(false);

    expect('plugin' in ctx).toBe(false);
    // matches / unsafeCast are core, not gated — they ride on every ctx.
    expect('matches' in ctx).toBe(true);
    expect('unsafeCast' in ctx).toBe(true);
  });

  it('ctx.matches / ctx.unsafeCast work on a server without intercepts()', async () => {
    const ctx = await captureCtx(probeServer(define({})));

    const frame = {
      event: 'probe',
      payload: {},
      kind: 'incoming' as const,
      routing: {},
      owner: { kind: 'app' as const },
    };

    expect(() => ctx.matches('probe', frame)).not.toThrow();
    expect(ctx.matches('probe', frame)).toBe(true);
    expect(ctx.unsafeCast('probe', frame)).toBe(frame);
  });

  it('scheduled() adds ctx.schedule / ctx.cancelScheduled that call through', async () => {
    const base = define({ capabilities: [scheduled({ cleanup: null })] });
    base.scheduled('cleanup', { run() {} });
    const ctx = await captureCtx(probeServer(base));

    expect('schedule' in ctx).toBe(true);
    expect('cancelScheduled' in ctx).toBe(true);

    ctx.schedule('cleanup', { time: Date.now() + 60_000 });
    expect(() => ctx.cancelScheduled('cleanup')).not.toThrow();
  });

  it('keepalive() adds live ctx.latency / ctx.quality', async () => {
    const base = define({
      capabilities: [keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 })],
    });
    const ctx = await captureCtx(probeServer(base));

    expect('latency' in ctx).toBe(true);
    expect('quality' in ctx).toBe(true);
    expect(ctx.latency).toBeNull();
    expect(ctx.quality).toBeNull();

    const raw = ctx[ENGINE_INTERNAL_CONNECTION];
    raw.latency = 12;
    raw.quality = 'good';
    expect(ctx.latency).toBe(12);
    expect(ctx.quality).toBe('good');
  });

  it('listing a plugin adds ctx.plugin; it resolves the api and throws for unknown ids', async () => {
    const ph = define({ scope: 'plugin', capabilities: [] });
    const beat = ph.on('beat', { input: v.object({}), run() {} });
    const Presence = plugin('acme:presence', {
      handler: ph.assemble({ handlers: [beat], api: () => ({ tag: 'presence-api' }) }),
    });

    const base = define({ capabilities: [Presence()] });
    const ctx = await captureCtx(probeServer(base));

    expect('plugin' in ctx).toBe(true);
    expect(ctx.plugin('acme:presence')).toEqual({ tag: 'presence-api' });
    expect(ctx.plugin('acme:presence')).toBe(ctx.plugin('acme:presence'));
    expect(() => ctx.plugin('acme:nope')).toThrow(/no plugin with id 'acme:nope' is registered/);
  });

  it('a stream-sweep-only server (recordedStream, no scheduled()) has no ctx.schedule', async () => {
    const base = define({
      capabilities: [recordedStream()],
    });
    const ctx = await captureCtx(probeServer(base));
    expect('schedule' in ctx).toBe(false);
    expect('cancelScheduled' in ctx).toBe(false);
  });
});
