import { request } from '~/primitives/request.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

describe('request', () => {
  it('produces correct tag and kind', () => {
    const p = request('get-history', async () => ({}));
    expect(p.__wskit).toBe('request');
    expect(p.__kind).toBe('handler');
  });

  it('produces compound identity keyed by event name', () => {
    const p = request('get-history', async () => ({}));
    expect(p.__identity[1]).toBe('get-history');
  });

  it('stores the event name', () => {
    const p = request('get-balance', async () => ({}));
    expect(p.event).toBe('get-balance');
  });

  it('stores the handler function', () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const p = request('test', handler);
    expect(p.handler).toBe(handler);
  });

  it('stores no validator when omitted', () => {
    const p = request('test', async () => ({}));
    expect(p.validator).toBeUndefined();
  });

  it('stores a parse function validator', () => {
    function validate(p: unknown) {
      return p as { limit: number };
    }
    const p = request('get-history', async () => ({}), { validator: validate });
    expect(p.validator).toBe(validate);
  });

  it('stores a valibot schema', () => {
    const schema = v.object({ limit: v.number() });
    const p = request(
      'get-history',
      async (_ctx, payload) => {
        return { messages: [], hasMore: payload.limit > 0 };
      },
      { validator: schema },
    );
    expect(p.validator).toBe(schema);
  });

  it('stores a zod schema', () => {
    const schema = z.object({ limit: z.number() });
    const p = request(
      'get-history',
      async (_ctx, payload) => {
        return { messages: [], hasMore: payload.limit > 0 };
      },
      { validator: schema },
    );
    expect(p.validator).toBe(schema);
  });

  it('factory has __key for dependency references', () => {
    expect(typeof request.__key).toBe('symbol');
  });

  it('has empty dependencies and requires', () => {
    const p = request('test', async () => ({}));
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });

  it('different events have different identities', () => {
    const a = request('get-history', async () => ({}));
    const b = request('get-balance', async () => ({}));
    expect(a.__identity[1]).toBe('get-history');
    expect(b.__identity[1]).toBe('get-balance');
    expect(a.__identity[0]).toBe(b.__identity[0]);
  });
});
