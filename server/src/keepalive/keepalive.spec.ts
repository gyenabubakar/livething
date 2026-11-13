import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { keepalive } from '~/keepalive/keepalive.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';

const OPTS = { pingIntervalMs: 15_000, idleTimeoutMs: 30_000 };

/**
 * A stand-in for the engine that records everything `keepalive()` registers, so
 * a test can fire each hook and watch what the capability does with it.
 */
function createFakeEngine(options: { hibernating?: boolean } = {}) {
  const connectHandlers: Array<(ctx: unknown) => void | Promise<void>> = [];
  const disconnectHandlers: Array<(ctx: unknown) => void | Promise<void>> = [];
  const cleanupHandlers: Array<(connectionId: string) => void> = [];
  const activityHandlers: Array<(connectionId: string) => void | Promise<void>> = [];
  const pongHandlers: Array<(connectionId: string) => void | Promise<void>> = [];

  const pingHandlers: Array<(connectionId: string) => void | Promise<void>> = [];
  const contextExtenders: Array<(baseCtx: unknown) => Record<string, unknown>> = [];
  const installed = new Set<symbol>();

  type CtxHandler = (ctx: unknown) => void | Promise<void>;
  type IdHandler = (connectionId: string) => void | Promise<void>;
  type ContextExtender = (baseCtx: unknown) => Record<string, unknown>;

  const engine = {
    installOnce(key: symbol, install: () => void) {
      if (installed.has(key)) return;

      installed.add(key);
      install();
    },
    setKeepaliveTimings: () => {},
    onConnect: (handler: CtxHandler) => void connectHandlers.push(handler),
    onDisconnect: (handler: CtxHandler) => void disconnectHandlers.push(handler),
    onConnectionCleanup: (handler: (id: string) => void) => void cleanupHandlers.push(handler),
    onConnectionActivity: (handler: IdHandler) => void activityHandlers.push(handler),
    onPing: (handler: IdHandler) => void pingHandlers.push(handler),
    onPong: (handler: IdHandler) => void pongHandlers.push(handler),
    extendContext: (factory: ContextExtender) => void contextExtenders.push(factory),
    getHibernationEnabled: () => options.hibernating ?? false,
    sendPing: vi.fn(),
    setConnectionLatency: vi.fn(),
    refreshConnectionIdleTimeout: vi.fn(),
  } as unknown as EngineAccess;

  return {
    engine,
    connectHandlers,
    disconnectHandlers,
    cleanupHandlers,
    activityHandlers,
    pingHandlers,
    pongHandlers,
    contextExtenders,
    sendPing: engine.sendPing as ReturnType<typeof vi.fn>,
    setConnectionLatency: engine.setConnectionLatency as ReturnType<typeof vi.fn>,
    refreshConnectionIdleTimeout: engine.refreshConnectionIdleTimeout as ReturnType<typeof vi.fn>,
  };
}

describe('keepalive', () => {
  it('produces correct tag', () => {
    const p = keepalive(OPTS);
    expect(p.__livething).toBe('keepalive');
  });

  it('uses singleton identity', () => {
    const p = keepalive(OPTS);
    expect(p.__identity).toHaveLength(1);
    expect(typeof p.__identity[0]).toBe('symbol');
  });

  it('instances have no required adapter capabilities', () => {
    expect(keepalive(OPTS).__requires).toEqual({});
  });

  describe('hook registration', () => {
    it('registers exactly the hooks it needs, and never a ping hook', () => {
      const fake = createFakeEngine();

      keepalive(OPTS).__setup?.(fake.engine);

      expect(fake.connectHandlers).toHaveLength(1);
      expect(fake.cleanupHandlers).toHaveLength(1);
      expect(fake.activityHandlers).toHaveLength(1);
      expect(fake.pongHandlers).toHaveLength(1);
      expect(fake.contextExtenders).toHaveLength(1);

      // Answering a client's ping is the engine's job, not this capability's.
      expect(fake.pingHandlers).toHaveLength(0);
    });

    it('releases the ping timer from cleanup, which a throwing disconnect hook cannot skip', () => {
      const fake = createFakeEngine();

      keepalive(OPTS).__setup?.(fake.engine);

      // Teardown must not sit on `onDisconnect`: a user hook that throws there
      // aborts the remaining disconnect hooks and would strand the ping timer.
      expect(fake.disconnectHandlers).toHaveLength(0);
    });

    it('opens the idle window on connect and on every inbound frame', () => {
      const fake = createFakeEngine();
      keepalive(OPTS).__setup?.(fake.engine);

      void fake.connectHandlers[0]!({ connection: { id: 'conn-1' } });
      void fake.activityHandlers[0]!('conn-1');

      expect(fake.refreshConnectionIdleTimeout.mock.calls).toEqual([
        ['conn-1', 30_000],
        ['conn-1', 30_000],
      ]);
    });

    it('ignores a connect context with no id', () => {
      const fake = createFakeEngine();
      keepalive(OPTS).__setup?.(fake.engine);

      void fake.connectHandlers[0]!({ connection: { id: '' } });

      expect(fake.refreshConnectionIdleTimeout).not.toHaveBeenCalled();
    });

    it('ignores a cleanup for a connection it never watched', () => {
      const fake = createFakeEngine();
      keepalive(OPTS).__setup?.(fake.engine);

      expect(() => fake.cleanupHandlers[0]!('never-seen')).not.toThrow();
    });
  });

  describe('the ping loop', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('pings a connected socket on the configured interval', () => {
      const fake = createFakeEngine();
      keepalive(OPTS).__setup?.(fake.engine);

      void fake.connectHandlers[0]!({ connection: { id: 'conn-1' } });
      vi.advanceTimersByTime(OPTS.pingIntervalMs);

      expect(fake.sendPing).toHaveBeenCalledWith('conn-1');
    });

    it('records the round-trip when the pong hook fires', () => {
      const fake = createFakeEngine();
      keepalive(OPTS).__setup?.(fake.engine);

      void fake.connectHandlers[0]!({ connection: { id: 'conn-1' } });
      vi.advanceTimersByTime(OPTS.pingIntervalMs);
      vi.setSystemTime(Date.now() + 80);
      void fake.pongHandlers[0]!('conn-1');

      expect(fake.setConnectionLatency).toHaveBeenCalledWith('conn-1', 80, 'excellent');
    });

    it('stops pinging once the connection is cleaned up', () => {
      const fake = createFakeEngine();
      keepalive(OPTS).__setup?.(fake.engine);

      void fake.connectHandlers[0]!({ connection: { id: 'conn-1' } });
      fake.cleanupHandlers[0]!('conn-1');
      vi.advanceTimersByTime(OPTS.pingIntervalMs * 5);

      expect(fake.sendPing).not.toHaveBeenCalled();
    });

    it('never pings and never arms the idle timer under hibernation', () => {
      const fake = createFakeEngine({ hibernating: true });
      keepalive(OPTS).__setup?.(fake.engine);

      void fake.connectHandlers[0]!({ connection: { id: 'conn-1' } });
      void fake.activityHandlers[0]!('conn-1');
      vi.advanceTimersByTime(OPTS.pingIntervalMs * 5);

      // A quiet-but-alive client under hibernation must never be closed: no
      // pending idle timer, and none held open by a `setTimeout` the instance
      // would have to stay resident just to keep counting down.
      expect(fake.sendPing).not.toHaveBeenCalled();
      expect(fake.refreshConnectionIdleTimeout).not.toHaveBeenCalled();
    });

    it('defaults to a 30 s ping and a 60 s idle window', () => {
      const fake = createFakeEngine();
      keepalive().__setup?.(fake.engine);

      void fake.connectHandlers[0]!({ connection: { id: 'conn-1' } });
      vi.advanceTimersByTime(29_999);
      expect(fake.sendPing).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(fake.sendPing).toHaveBeenCalledWith('conn-1');
      expect(fake.refreshConnectionIdleTimeout).toHaveBeenCalledWith('conn-1', 60_000);
    });

    it('fills in only the option left out', () => {
      const fake = createFakeEngine();
      keepalive({ idleTimeoutMs: 90_000 }).__setup?.(fake.engine);

      void fake.connectHandlers[0]!({ connection: { id: 'conn-1' } });
      vi.advanceTimersByTime(30_000);

      expect(fake.sendPing).toHaveBeenCalledWith('conn-1');
      expect(fake.refreshConnectionIdleTimeout).toHaveBeenCalledWith('conn-1', 90_000);
    });

    it('still opens and refreshes the idle window without hibernation', () => {
      const fake = createFakeEngine({ hibernating: false });
      keepalive(OPTS).__setup?.(fake.engine);

      void fake.connectHandlers[0]!({ connection: { id: 'conn-1' } });
      void fake.activityHandlers[0]!('conn-1');

      expect(fake.refreshConnectionIdleTimeout.mock.calls).toEqual([
        ['conn-1', 30_000],
        ['conn-1', 30_000],
      ]);
    });
  });

  it('installs a live ctx.latency / ctx.quality surface gated on hibernation', () => {
    let hibernating = false;
    const fake = createFakeEngine();
    (fake.engine as { getHibernationEnabled: () => boolean }).getHibernationEnabled = () =>
      hibernating;

    keepalive(OPTS).__setup?.(fake.engine);
    expect(fake.contextExtenders).toHaveLength(1);

    const connection = { latency: null as number | null, quality: 'good' };
    const baseCtx = { [ENGINE_INTERNAL_CONNECTION]: connection } as Record<PropertyKey, unknown>;
    Object.defineProperties(
      baseCtx,
      Object.getOwnPropertyDescriptors(fake.contextExtenders[0]!(baseCtx)),
    );

    expect(baseCtx.latency).toBeNull();
    expect(baseCtx.quality).toBeNull();

    connection.latency = 42;
    connection.quality = 'excellent';
    expect(baseCtx.latency).toBe(42);
    expect(baseCtx.quality).toBe('excellent');

    hibernating = true;
    expect(baseCtx.quality).toBeNull();
  });

  describe('validation', () => {
    it('rejects a non-positive or non-integer pingIntervalMs', () => {
      expect(() => keepalive({ pingIntervalMs: 0, idleTimeoutMs: 30_000 })).toThrow();
      expect(() => keepalive({ pingIntervalMs: -5, idleTimeoutMs: 30_000 })).toThrow();
      expect(() => keepalive({ pingIntervalMs: 1.5, idleTimeoutMs: 30_000 })).toThrow();
    });

    it('rejects a non-positive or non-integer idleTimeoutMs', () => {
      expect(() => keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 0 })).toThrow();
      expect(() => keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: -5 })).toThrow();
    });

    it('rejects pingIntervalMs that is not strictly less than idleTimeoutMs', () => {
      expect(() => keepalive({ pingIntervalMs: 30_000, idleTimeoutMs: 30_000 })).toThrow(
        /must be less than/,
      );
      expect(() => keepalive({ pingIntervalMs: 40_000, idleTimeoutMs: 30_000 })).toThrow(
        /must be less than/,
      );
    });

    it('checks one user value against the default of the other', () => {
      expect(() => keepalive({ pingIntervalMs: 60_000 })).toThrow(/must be less than/);
      expect(() => keepalive({ idleTimeoutMs: 30_000 })).toThrow(/must be less than/);
    });
  });
});
