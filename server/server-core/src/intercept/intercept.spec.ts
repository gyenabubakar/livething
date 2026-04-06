import { intercept } from '~/intercept/intercept.ts';
import { describe, expect, it } from 'vitest';

describe('intercept', () => {
  it('creates a pre-validation intercept', () => {
    async function handler() {}
    const p = intercept(handler);

    expect(p.__wskit).toBe('intercept');
    expect(p.__kind).toBe('infrastructure');
    expect(p.mode).toBe('pre');
    expect(p.handler).toBe(handler);
  });

  it('creates a post-validation intercept', () => {
    async function handler() {}
    const p = intercept('send-message', handler);

    expect(p.__wskit).toBe('intercept');
    expect(p.__kind).toBe('infrastructure');
    expect(p.mode).toBe('post');
    expect(p.event).toBe('send-message');
    expect(p.handler).toBe(handler);
  });

  it('uses repeatable identity', () => {
    const pre = intercept(async () => {});
    const post = intercept('send-message', async () => {});

    expect(pre.__identity).toEqual([intercept.__key, 'pre']);
    expect(post.__identity).toEqual([intercept.__key, 'post:send-message']);
  });

  it('instances have empty dependencies and requires', () => {
    const p = intercept(async () => {});
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });
});
