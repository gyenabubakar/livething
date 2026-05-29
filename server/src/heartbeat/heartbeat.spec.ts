import { heartbeat } from '~/heartbeat/heartbeat.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';

describe('heartbeat', () => {
  it('produces correct tag, kind, and timeout', () => {
    const p = heartbeat({ timeout: 30_000 });
    expect(p.__wskit).toBe('heartbeat');
    expect(p.__kind).toBe('infrastructure');
    expect(p.timeout).toBe(30_000);
  });

  it('uses singleton identity', () => {
    const p = heartbeat({ timeout: 30_000 });
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(heartbeat.__key);
  });

  it('instances have no required adapter capabilities', () => {
    const p = heartbeat({ timeout: 30_000 });
    expect(p.__requires).toEqual({});
  });

  it('registers connect and activity hooks through setup', () => {
    const connectHandlers: Array<NonNullable<Parameters<EngineAccess['onConnect']>[0]>> = [];
    const activityHandlers: Array<
      NonNullable<Parameters<EngineAccess['onConnectionActivity']>[0]>
    > = [];
    const refreshed: Array<{ connectionId: string; timeoutMs: number }> = [];
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
      setHeartbeatPingInterval() {},
      refreshConnectionIdleTimeout(connectionId: string, timeoutMs: number) {
        refreshed.push({ connectionId, timeoutMs });
      },
    } as Pick<
      EngineAccess,
      | 'installOnce'
      | 'onConnect'
      | 'onConnectionActivity'
      | 'refreshConnectionIdleTimeout'
      | 'setHeartbeatPingInterval'
    > as EngineAccess;

    heartbeat({ timeout: 30_000 }).__setup?.(engine);

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
      setHeartbeatPingInterval() {},
      refreshConnectionIdleTimeout(connectionId: string) {
        refreshed.push(connectionId);
      },
    } as Pick<
      EngineAccess,
      | 'installOnce'
      | 'onConnect'
      | 'onConnectionActivity'
      | 'refreshConnectionIdleTimeout'
      | 'setHeartbeatPingInterval'
    > as EngineAccess;

    heartbeat({ timeout: 30_000 }).__setup?.(engine);
    void connectHandlers[0]!({ id: '' });

    expect(refreshed).toHaveLength(0);
  });

  describe('keepalive ping interval', () => {
    function setIntervalFor(timeout: number): number | undefined {
      let pingIntervalMs: number | undefined;
      const installs = new Set<symbol>();
      const engine = {
        installOnce(key, install) {
          if (installs.has(key)) return;
          installs.add(key);
          install();
        },
        onConnect() {},
        onConnectionActivity() {},
        refreshConnectionIdleTimeout() {},
        setHeartbeatPingInterval(intervalMs: number) {
          pingIntervalMs = intervalMs;
        },
      } as Pick<
        EngineAccess,
        | 'installOnce'
        | 'onConnect'
        | 'onConnectionActivity'
        | 'refreshConnectionIdleTimeout'
        | 'setHeartbeatPingInterval'
      > as EngineAccess;

      heartbeat({ timeout }).__setup?.(engine);
      return pingIntervalMs;
    }

    it('pings at half the timeout when that lands inside the clamp range', () => {
      expect(setIntervalFor(20_000)).toBe(10_000);
      expect(setIntervalFor(60_000)).toBe(30_000);
    });

    it('caps the interval at 30s for a large timeout (still well under the window)', () => {
      expect(setIntervalFor(600_000)).toBe(30_000);
    });

    it('floors the interval at 1s for a tiny timeout', () => {
      expect(setIntervalFor(1_000)).toBe(1_000);
    });
  });

  it('rejects a non-positive or non-integer timeout', () => {
    expect(() => heartbeat({ timeout: 0 })).toThrow();
    expect(() => heartbeat({ timeout: -5 })).toThrow();
    expect(() => heartbeat({ timeout: 1.5 })).toThrow();
  });
});
