import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/types.ts';
import { keepalive } from '~/keepalive/keepalive.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';

const OPTS = { pingIntervalMs: 15_000, idleTimeoutMs: 30_000 };

describe('keepalive', () => {
  it('produces correct tag, kind, and option fields', () => {
    const p = keepalive(OPTS);
    expect(p.__wskit).toBe('keepalive');
    expect(p.__kind).toBe('infrastructure');
    expect(p.pingIntervalMs).toBe(15_000);
    expect(p.idleTimeoutMs).toBe(30_000);
  });

  it('uses singleton identity', () => {
    const p = keepalive(OPTS);
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(keepalive.__key);
  });

  it('instances have no required adapter capabilities', () => {
    expect(keepalive(OPTS).__requires).toEqual({});
  });

  it('registers hooks, sets the ping interval, and refreshes with idleTimeoutMs', () => {
    const connectHandlers: Array<NonNullable<Parameters<EngineAccess['onConnect']>[0]>> = [];
    const activityHandlers: Array<
      NonNullable<Parameters<EngineAccess['onConnectionActivity']>[0]>
    > = [];
    const refreshed: Array<{ connectionId: string; timeoutMs: number }> = [];
    let pingIntervalMs: number | undefined;
    const installs = new Set<symbol>();

    const engine = {
      installOnce(key, install) {
        if (installs.has(key)) return;
        installs.add(key);
        install();
      },
      onConnect(handler) {
        connectHandlers.push(handler);
      },
      onConnectionActivity(handler) {
        activityHandlers.push(handler);
      },
      setKeepalivePingInterval(intervalMs: number) {
        pingIntervalMs = intervalMs;
      },
      refreshConnectionIdleTimeout(connectionId: string, timeoutMs: number) {
        refreshed.push({ connectionId, timeoutMs });
      },
      extendContext() {},
      getHibernationEnabled() {
        return false;
      },
    } as Pick<
      EngineAccess,
      | 'installOnce'
      | 'onConnect'
      | 'onConnectionActivity'
      | 'refreshConnectionIdleTimeout'
      | 'setKeepalivePingInterval'
      | 'extendContext'
      | 'getHibernationEnabled'
    > as EngineAccess;

    keepalive(OPTS).__setup?.(engine);

    expect(pingIntervalMs).toBe(15_000);
    expect(connectHandlers).toHaveLength(1);
    expect(activityHandlers).toHaveLength(1);

    void connectHandlers[0]!({ id: 'conn-1' });
    void activityHandlers[0]!('conn-1');

    expect(refreshed).toEqual([
      { connectionId: 'conn-1', timeoutMs: 30_000 },
      { connectionId: 'conn-1', timeoutMs: 30_000 },
    ]);
  });

  it('skips refreshConnectionIdleTimeout when ctx.id is falsy (empty string)', () => {
    const connectHandlers: Array<NonNullable<Parameters<EngineAccess['onConnect']>[0]>> = [];
    const refreshed: Array<string> = [];
    const installs = new Set<symbol>();

    const engine = {
      installOnce(key, install) {
        if (installs.has(key)) return;
        installs.add(key);
        install();
      },
      onConnect(handler) {
        connectHandlers.push(handler);
      },
      onConnectionActivity() {},
      setKeepalivePingInterval() {},
      refreshConnectionIdleTimeout(connectionId: string) {
        refreshed.push(connectionId);
      },
      extendContext() {},
      getHibernationEnabled() {
        return false;
      },
    } as Pick<
      EngineAccess,
      | 'installOnce'
      | 'onConnect'
      | 'onConnectionActivity'
      | 'refreshConnectionIdleTimeout'
      | 'setKeepalivePingInterval'
      | 'extendContext'
      | 'getHibernationEnabled'
    > as EngineAccess;

    keepalive(OPTS).__setup?.(engine);
    void connectHandlers[0]!({ id: '' });

    expect(refreshed).toHaveLength(0);
  });

  it('installs a live ctx.latency / ctx.quality surface gated on hibernation', () => {
    const extenders: Array<(baseCtx: unknown) => Record<string, unknown>> = [];
    let hibernating = false;
    const engine = {
      installOnce(_key, install) {
        install();
      },
      onConnect() {},
      onConnectionActivity() {},
      setKeepalivePingInterval() {},
      refreshConnectionIdleTimeout() {},
      extendContext(factory) {
        extenders.push(factory);
      },
      getHibernationEnabled() {
        return hibernating;
      },
    } as Pick<
      EngineAccess,
      | 'installOnce'
      | 'onConnect'
      | 'onConnectionActivity'
      | 'refreshConnectionIdleTimeout'
      | 'setKeepalivePingInterval'
      | 'extendContext'
      | 'getHibernationEnabled'
    > as EngineAccess;

    keepalive(OPTS).__setup?.(engine);
    expect(extenders).toHaveLength(1);

    const connection = { latency: null as number | null, quality: 'good' };
    const baseCtx = { [ENGINE_INTERNAL_CONNECTION]: connection } as Record<PropertyKey, unknown>;
    Object.defineProperties(baseCtx, Object.getOwnPropertyDescriptors(extenders[0]!(baseCtx)));

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
  });
});
