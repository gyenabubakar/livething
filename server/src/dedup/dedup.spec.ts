import { dedup } from '~/dedup/dedup.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';

function installDedup(): {
  stampHandlers: Array<NonNullable<Parameters<EngineAccess['onWskitStamp']>[0]>>;
  hook: NonNullable<Parameters<EngineAccess['onWskitStamp']>[0]>;
} {
  const stampHandlers: Array<NonNullable<Parameters<EngineAccess['onWskitStamp']>[0]>> = [];
  const installs = new Set<symbol>();
  let nextId = 1;

  const engine = {
    installOnce(key, install) {
      if (installs.has(key)) return;

      installs.add(key);
      install();
    },
    onWskitStamp(handler) {
      stampHandlers.push(handler);
    },
    generateId(prefix = 'id') {
      return `${prefix}-${nextId++}`;
    },
    enableIncomingDedup() {},
  } as Pick<
    EngineAccess,
    'generateId' | 'installOnce' | 'onWskitStamp' | 'enableIncomingDedup'
  > as EngineAccess;

  dedup().__setup?.(engine);

  const hook = stampHandlers[0];

  expect(hook).toBeDefined();

  return {
    stampHandlers,
    hook: hook!,
  };
}

describe('dedup', () => {
  it('produces correct tag and kind', () => {
    const p = dedup();
    expect(p.__wskit).toBe('dedup');
    expect(p.__kind).toBe('infrastructure');
  });

  it('uses singleton identity', () => {
    const p = dedup();
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(dedup.__key);
  });

  it('instances have empty dependencies and requires', () => {
    const p = dedup();
    expect(p.__requires).toEqual({});
  });

  it('registers its stamp hook only once', () => {
    const stampHandlers: Array<NonNullable<Parameters<EngineAccess['onWskitStamp']>[0]>> = [];
    const installs = new Set<symbol>();
    let nextId = 1;
    const engine = {
      installOnce(key, install) {
        if (installs.has(key)) return;

        installs.add(key);
        install();
      },
      onWskitStamp(handler) {
        stampHandlers.push(handler);
      },
      generateId(prefix = 'id') {
        return `${prefix}-${nextId++}`;
      },
      enableIncomingDedup() {},
    } as Pick<
      EngineAccess,
      'generateId' | 'installOnce' | 'onWskitStamp' | 'enableIncomingDedup'
    > as EngineAccess;

    dedup().__setup?.(engine);
    dedup().__setup?.(engine);

    expect(stampHandlers).toHaveLength(1);
  });

  it('stamps a unique messageId into __wskit for outgoing messages', () => {
    const { hook } = installDedup();
    const first = hook('message');
    const second = hook('alert');

    expect(first).toEqual({ messageId: 'msg-1' });
    expect(second).toEqual({ messageId: 'msg-2' });
  });

  it('still stamps module-owned outgoing events with a double underscore prefix', () => {
    const { hook } = installDedup();
    const moduleMessage = hook('__acme:analytics:flushed');

    expect(moduleMessage).toEqual({ messageId: 'msg-1' });
  });
});
