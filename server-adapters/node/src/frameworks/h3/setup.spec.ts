import { server as createServerDefinition } from '@livething/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createH3Setup } from './setup.ts';

interface TestHooks {
  upgrade(): Promise<Response | { context: { upgrade: unknown } } | void>;
}

describe('H3 v2 Fetch request fallback', () => {
  let livething: ReturnType<typeof createH3Setup> | undefined;

  afterEach(async () => {
    await livething?.shutdown();
    livething = undefined;
  });

  it('prepares an upgrade when H3 has no raw Node request', async () => {
    let createHooks: ((event: { req: Request }) => TestHooks | Promise<TestHooks>) | undefined;
    const route = Symbol('route');
    livething = createH3Setup((factory) => {
      createHooks = factory;
      return route;
    });
    const definition = createServerDefinition({
      authenticate: () => ({ userId: 'u1' }),
      capabilities: [],
    }).assemble({ handlers: [] });
    const endpoint = livething.bind(definition, { sql: ':memory:' });

    await livething.ready();

    expect(endpoint.upgrade).toBe(route);
    const request = {
      url: 'http://localhost/ws',
      method: 'GET',
      headers: new Headers({ upgrade: 'websocket' }),
      signal: new AbortController().signal,
    } as Request;
    const hooks = await createHooks!({ req: request });
    const result = await hooks.upgrade();

    expect(result).toMatchObject({ context: { upgrade: { type: 'accept' } } });
  });

  it('answers a non-WebSocket request with 400 without running authenticate', async () => {
    let createHooks: ((event: { req: Request }) => TestHooks | Promise<TestHooks>) | undefined;
    livething = createH3Setup((factory) => {
      createHooks = factory;
      return Symbol('route');
    });
    const authenticate = vi.fn(() => ({ userId: 'u1' }));
    const definition = createServerDefinition({ authenticate, capabilities: [] }).assemble({
      handlers: [],
    });
    livething.bind(definition, { sql: ':memory:' });

    await livething.ready();
    const hooks = await createHooks!({
      req: new Request('http://localhost/ws', { headers: { upgrade: 'h2c' } }),
    });
    const result = await hooks.upgrade();

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('rejects clientIp configuration when H3 has no raw Node request', async () => {
    let createHooks: ((event: { req: Request }) => TestHooks | Promise<TestHooks>) | undefined;
    livething = createH3Setup((factory) => {
      createHooks = factory;
      return Symbol('route');
    });
    const definition = createServerDefinition({
      authenticate: () => ({ userId: 'u1' }),
      capabilities: [],
    }).assemble({ handlers: [] });
    livething.bind(definition, {
      sql: ':memory:',
      clientIp: { mode: 'direct' },
    });
    await livething.ready();

    const hooks = await createHooks!({
      req: new Request('http://localhost/ws', { headers: { upgrade: 'websocket' } }),
    });

    await expect(hooks.upgrade()).rejects.toThrow(
      '[livething] H3 did not provide a Node request required by clientIp',
    );
  });
});
