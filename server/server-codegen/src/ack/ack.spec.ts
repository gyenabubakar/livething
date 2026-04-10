import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import { ack } from '~/ack/ack.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';

describe('ack', () => {
  it('produces correct tag and kind', () => {
    const p = ack();
    expect(p.__wskit).toBe('ack');
    expect(p.__kind).toBe('infrastructure');
  });

  it('uses singleton identity', () => {
    const p = ack();
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(ack.__key);
  });

  it('instances have empty dependencies and requires', () => {
    const p = ack();
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });

  it('factory has a symbol key for dependency references', () => {
    expect(typeof ack.__key).toBe('symbol');
  });

  it('adds ctx.ack() only for top-level connection contexts', () => {
    const extenders: Array<NonNullable<Parameters<EngineAccess['extendContext']>[0]>> = [];
    const sent: string[] = [];
    const engine = {
      extendContext(factory) {
        extenders.push(factory);
      },
      sendAck(connectionId: string) {
        sent.push(connectionId);
      },
    } as Pick<EngineAccess, 'extendContext' | 'sendAck'> as EngineAccess;

    ack().__setup?.(engine);

    const topLevelCtx: Record<PropertyKey, unknown> = {
      id: 'c1',
      [ENGINE_SCOPE_META]: {},
    };
    const namespacedCtx: Record<PropertyKey, unknown> = {
      id: 'c2',
      [ENGINE_SCOPE_META]: { namespaceName: 'admin' },
    };

    Object.assign(topLevelCtx, extenders[0]!(topLevelCtx));
    Object.assign(namespacedCtx, extenders[0]!(namespacedCtx));

    expect(typeof topLevelCtx.ack).toBe('function');
    expect(namespacedCtx.ack).toBeUndefined();

    (topLevelCtx.ack as () => void)();
    expect(sent).toEqual(['c1']);
  });
});
