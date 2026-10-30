import { request } from '~/request/request.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';

describe('request', () => {
  it('produces correct tag', () => {
    const p = request('get-history', async () => {});
    expect(p.__livething).toBe('request');
  });

  it('produces compound identity keyed by event name', () => {
    const p = request('get-history', async () => {});
    expect(p.__identity[1]).toBe('get-history');
  });

  it('stores the event name', () => {
    const p = request('get-balance', async () => {});
    expect(p.event).toBe('get-balance');
  });

  it('stores the handler function', () => {
    const handler = vi.fn();
    const p = request('test', handler);
    expect(p.handler).toBe(handler);
  });

  it('stores no validator when omitted', () => {
    const p = request('test', async () => {});
    expect(p.validator).toBeUndefined();
  });

  it('stores a valibot schema', () => {
    const schema = v.object({ limit: v.number() });
    const p = request(
      'get-history',
      async (ctx, _payload) => {
        ctx.respond({ messages: [], hasMore: true });
      },
      { validator: schema },
    );
    expect(p.validator).toBe(schema);
  });

  it('has empty dependencies and requires', () => {
    const p = request('test', async () => {});
    expect(p.__requires).toEqual({});
  });

  it('different events have different identities', () => {
    const a = request('get-history', async () => {});
    const b = request('get-balance', async () => {});
    expect(a.__identity[1]).toBe('get-history');
    expect(b.__identity[1]).toBe('get-balance');
    expect(a.__identity[0]).toBe(b.__identity[0]);
  });
});
