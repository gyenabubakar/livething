import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { onBeforeSubscribe, onSubscribe, onUnsubscribe } from './lifecycle.ts';

describe('channel lifecycle primitives', () => {
  it('creates onBeforeSubscribe with optional validator and setup hook', () => {
    const engine = {
      onBeforeSubscribe: vi.fn(),
    };
    const handler = vi.fn();
    const validator = v.object({ token: v.string() });
    const primitive = onBeforeSubscribe(handler, { validator });

    expect(primitive.__wskit).toBe('onBeforeSubscribe');
    expect(primitive.__kind).toBe('lifecycle');
    expect(primitive.validator).toBe(validator);

    primitive.__setup?.(engine as any);
    expect(engine.onBeforeSubscribe).toHaveBeenCalledWith(handler, validator);
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

    subscribePrimitive.__setup?.(engine as any);
    unsubscribePrimitive.__setup?.(engine as any);

    expect(engine.onSubscribe).toHaveBeenCalledWith(subscribe);
    expect(engine.onUnsubscribe).toHaveBeenCalledWith(unsubscribe);
  });
});
