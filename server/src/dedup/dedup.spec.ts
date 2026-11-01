import { dedup } from '~/dedup/dedup.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';

function makeEngine(): {
  engine: EngineAccess;
  stampHandlers: Array<NonNullable<Parameters<EngineAccess['onLiveThingStamp']>[0]>>;
  enableCaps: number[];
} {
  const stampHandlers: Array<NonNullable<Parameters<EngineAccess['onLiveThingStamp']>[0]>> = [];
  const enableCaps: number[] = [];
  const installs = new Set<symbol>();
  let nextId = 1;

  const engine = {
    installOnce(key, install) {
      if (installs.has(key)) return;

      installs.add(key);
      install();
    },
    onLiveThingStamp(handler) {
      stampHandlers.push(handler);
    },
    generateId(prefix = 'id') {
      return `${prefix}-${nextId++}`;
    },
    enableIncomingDedup(cap: number) {
      enableCaps.push(cap);
    },
  } as Pick<
    EngineAccess,
    'generateId' | 'installOnce' | 'onLiveThingStamp' | 'enableIncomingDedup'
  > as EngineAccess;

  return { engine, stampHandlers, enableCaps };
}

function installDedup(): {
  hook: NonNullable<Parameters<EngineAccess['onLiveThingStamp']>[0]>;
} {
  const { engine, stampHandlers } = makeEngine();
  dedup().__setup?.(engine);

  const hook = stampHandlers[0];
  expect(hook).toBeDefined();

  return { hook: hook! };
}

describe('dedup', () => {
  it('produces correct tag', () => {
    const p = dedup();
    expect(p.__livething).toBe('dedup');
  });

  it('uses singleton identity', () => {
    const p = dedup();
    expect(p.__identity).toHaveLength(1);
    expect(typeof p.__identity[0]).toBe('symbol');
  });

  it('instances have empty dependencies and requires', () => {
    const p = dedup();
    expect(p.__requires).toEqual({});
  });

  it('registers its stamp hook only once', () => {
    const { engine, stampHandlers } = makeEngine();

    dedup().__setup?.(engine);
    dedup().__setup?.(engine);

    expect(stampHandlers).toHaveLength(1);
  });

  it('enables incoming dedup with the default cap of 256', () => {
    const { engine, enableCaps } = makeEngine();
    dedup().__setup?.(engine);
    expect(enableCaps).toEqual([256]);
  });

  it('enables incoming dedup with a caller-supplied cap', () => {
    const { engine, enableCaps } = makeEngine();
    dedup({ cap: 10 }).__setup?.(engine);
    expect(enableCaps).toEqual([10]);
  });

  it('stamps a unique messageId into __livething for outgoing messages', () => {
    const { hook } = installDedup();
    const first = hook('message');
    const second = hook('alert');

    expect(first).toEqual({ messageId: 'msg-1' });
    expect(second).toEqual({ messageId: 'msg-2' });
  });
});
