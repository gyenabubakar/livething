import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import { check, commit, onSubscribe, onUnsubscribe } from './lifecycle.ts';

describe('channel lifecycle primitives', () => {
  it('creates check with optional validator and setup hook', () => {
    const engine = {
      onCheck: vi.fn(),
    };

    const handler = vi.fn();
    const validator = v.object({ token: v.string() });
    const primitive = check(handler, { validator });

    expect(primitive.__wskit).toBe('check');
    expect(primitive.__kind).toBe('lifecycle');
    expect(primitive.validator).toBe(validator);

    primitive.__setup?.(engine as unknown as EngineAccess);
    expect(engine.onCheck).toHaveBeenCalledWith(handler, validator);
  });

  it('creates check without validator', () => {
    const engine = { onCheck: vi.fn() };
    const handler = vi.fn();
    const primitive = check(handler);

    expect(primitive.validator).toBeUndefined();
    primitive.__setup?.(engine as unknown as EngineAccess);
    expect(engine.onCheck).toHaveBeenCalledWith(handler, undefined);
  });

  it('creates commit and wires to onCommit', () => {
    const engine = { onCommit: vi.fn() };
    const handler = vi.fn();
    const primitive = commit(handler);

    expect(primitive.__wskit).toBe('commit');
    expect(primitive.__kind).toBe('lifecycle');
    expect(primitive.handler).toBe(handler);

    primitive.__setup?.(engine as unknown as EngineAccess);
    expect(engine.onCommit).toHaveBeenCalledWith(handler);
  });

  it('creates onSubscribe and onUnsubscribe setup hooks', () => {
    const engine = {
      onSubscribe: vi.fn(),
      onUnsubscribe: vi.fn(),
    };

    const subscribe = vi.fn();
    const unsubscribe = vi.fn();

    const subscribePrimitive = onSubscribe(subscribe);
    const unsubscribePrimitive = onUnsubscribe(unsubscribe);

    subscribePrimitive.__setup?.(engine as unknown as EngineAccess);
    unsubscribePrimitive.__setup?.(engine as unknown as EngineAccess);

    expect(engine.onSubscribe).toHaveBeenCalledWith(subscribe);
    expect(engine.onUnsubscribe).toHaveBeenCalledWith(unsubscribe);
  });
});
