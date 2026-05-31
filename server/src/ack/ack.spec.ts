import { ENGINE_ACK_ID, ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
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
    expect(p.__requires).toEqual({});
  });

  it('factory has a symbol key for dependency references', () => {
    expect(typeof ack.__key).toBe('symbol');
  });

  it('adds ctx.ack() only for top-level connection contexts', () => {
    const extenders: Array<NonNullable<Parameters<EngineAccess['extendContext']>[0]>> = [];
    const sent: Array<{ connectionId: string; ackId: string | undefined }> = [];
    const engine = {
      extendContext(factory) {
        extenders.push(factory);
      },
      sendAck(connectionId: string, ackId: string | undefined) {
        sent.push({ connectionId, ackId });
      },
    } as Pick<EngineAccess, 'extendContext' | 'sendAck'> as EngineAccess;

    ack().__setup?.(engine);

    const topLevelCtx: Record<PropertyKey, unknown> = {
      id: 'c1',
      [ENGINE_SCOPE_META]: {},
      [ENGINE_ACK_ID]: 'ack-1',
    };
    const namespacedCtx: Record<PropertyKey, unknown> = {
      id: 'c2',
      [ENGINE_SCOPE_META]: { namespaceName: 'admin' },
    };

    const channelCtx: Record<PropertyKey, unknown> = {
      id: 'c3',
      [ENGINE_SCOPE_META]: { channelName: 'room-1' },
    };

    Object.assign(topLevelCtx, extenders[0]!(topLevelCtx));
    Object.assign(namespacedCtx, extenders[0]!(namespacedCtx));
    Object.assign(channelCtx, extenders[0]!(channelCtx));

    expect(typeof topLevelCtx.ack).toBe('function');
    expect(namespacedCtx.ack).toBeUndefined();
    expect(channelCtx.ack).toBeUndefined();

    (topLevelCtx.ack as () => void)();
    expect(sent).toEqual([{ connectionId: 'c1', ackId: 'ack-1' }]);
  });

  it('ctx.ack() sends the ack id carried on its own context', () => {
    const extenders: Array<NonNullable<Parameters<EngineAccess['extendContext']>[0]>> = [];
    const sent: Array<{ connectionId: string; ackId: string | undefined }> = [];
    const engine = {
      extendContext(factory) {
        extenders.push(factory);
      },
      sendAck(connectionId: string, ackId: string | undefined) {
        sent.push({ connectionId, ackId });
      },
    } as Pick<EngineAccess, 'extendContext' | 'sendAck'> as EngineAccess;

    ack().__setup?.(engine);

    // Two contexts for the same connection, each carrying its own ack id —
    // ack() must read its own ctx, not a value shared across the connection.
    const ctxA: Record<PropertyKey, unknown> = {
      id: 'c1',
      [ENGINE_SCOPE_META]: {},
      [ENGINE_ACK_ID]: 'ack-a',
    };
    const ctxB: Record<PropertyKey, unknown> = {
      id: 'c1',
      [ENGINE_SCOPE_META]: {},
      [ENGINE_ACK_ID]: 'ack-b',
    };
    Object.assign(ctxA, extenders[0]!(ctxA));
    Object.assign(ctxB, extenders[0]!(ctxB));

    (ctxA.ack as () => void)();
    (ctxB.ack as () => void)();

    expect(sent).toEqual([
      { connectionId: 'c1', ackId: 'ack-a' },
      { connectionId: 'c1', ackId: 'ack-b' },
    ]);
  });
});
