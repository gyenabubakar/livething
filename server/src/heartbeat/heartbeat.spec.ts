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

  it('instances have empty dependencies and timer requirement', () => {
    const p = heartbeat({ timeout: 30_000 });
    expect(p.__requires).toEqual({ timers: true });
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
      refreshConnectionIdleTimeout(connectionId: string, timeoutMs: number) {
        refreshed.push({ connectionId, timeoutMs });
      },
    } as Pick<
      EngineAccess,
      'installOnce' | 'onConnect' | 'onConnectionActivity' | 'refreshConnectionIdleTimeout'
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
      refreshConnectionIdleTimeout(connectionId: string) {
        refreshed.push(connectionId);
      },
    } as Pick<
      EngineAccess,
      'installOnce' | 'onConnect' | 'onConnectionActivity' | 'refreshConnectionIdleTimeout'
    > as EngineAccess;

    heartbeat({ timeout: 30_000 }).__setup?.(engine);
    void connectHandlers[0]!({ id: '' });

    expect(refreshed).toHaveLength(0);
  });
});
