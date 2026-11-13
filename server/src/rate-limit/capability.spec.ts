import { server } from '~/_define/server.ts';
import { clientRequests } from '~/request/client-requests.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { AnyCapability } from '~/_define/capability.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { rateLimit } from './capability.ts';

function interceptCount(definition: ServerDefinition): number {
  return definition.primitives.filter((p) => p.__livething === 'intercept').length;
}

describe('rateLimit() capability', () => {
  it('installs a rate-limit intercept from the global rule', () => {
    const base = server({
      capabilities: [rateLimit({ maxMessages: 100 })],
    });
    expect(interceptCount(base.assemble({ handlers: [] }))).toBe(1);
  });

  it('installs the intercept from a per-handler override with no global default', () => {
    const base = server({ capabilities: [rateLimit()] });
    const handler = base.on('expensive', {
      input: v.object({}),
      rateLimit: { maxMessages: 1, windowMs: 10_000 },
      run() {},
    });
    expect(interceptCount(base.assemble({ handlers: [handler] }))).toBe(1);
  });

  it('collects a per-handler override from a request as well as an on handler', () => {
    const base = server({
      capabilities: [rateLimit(), clientRequests()],
    });
    const ask = base.request('ask', {
      input: v.object({}),
      rateLimit: { maxMessages: 2 },
      run() {
        return {};
      },
    });
    expect(interceptCount(base.assemble({ handlers: [ask] }))).toBe(1);
  });

  it('still installs the intercept when a global rule is set and one handler disables its limit', () => {
    const base = server({
      capabilities: [rateLimit({ maxMessages: 100 })],
    });
    const free = base.on('free', {
      input: v.object({}),
      rateLimit: false,
      run() {},
    });
    expect(interceptCount(base.assemble({ handlers: [free] }))).toBe(1);
  });

  it('keeps a `rateLimit: false` override instead of dropping it as unset', () => {
    const base = server({ capabilities: [rateLimit()] });
    const free = base.on('free', { input: v.object({}), rateLimit: false, run() {} });
    expect(interceptCount(base.assemble({ handlers: [free] }))).toBe(1);
  });

  it('adds no rate-limit intercept when the capability has no global rule and no overrides', () => {
    const base = server({ capabilities: [rateLimit()] });
    const handler = base.on('plain', { input: v.object({}), run() {} });
    expect(interceptCount(base.assemble({ handlers: [handler] }))).toBe(0);
  });

  it('throws at assemble when a handler smuggles a rateLimit override past the type gate without the capability', () => {
    // The type gate (RateLimitField) makes `rateLimit` a compile error here; the
    // cast bypasses it to prove the assemble-time throw is still wired as
    // defense-in-depth for code that sidesteps the types.
    const base = server({});
    const handler = base.on('plain', {
      input: v.object({}),
      ...({ rateLimit: { maxMessages: 1 } } as object),
      run() {},
    });
    expect(() => base.assemble({ handlers: [handler] })).toThrow(
      /per-handler rateLimit override needs the rateLimit\(\) capability/,
    );
  });

  it('keeps the rule it was given when the caller edits the config object afterwards', () => {
    const config = { windowMs: 60_000, maxMessages: 100 };
    const capability = rateLimit(config);

    config.maxMessages = 1;

    expect(capability.__rateLimit).toEqual({ windowMs: 60_000, maxMessages: 100 });
  });

  it('throws when rateLimit() is listed more than once', () => {
    const capabilities: AnyCapability[] = [
      rateLimit({ maxMessages: 10 }),
      rateLimit({ maxMessages: 20 }),
    ];
    expect(() => server({ capabilities })).toThrow(/rateLimit\(\) is listed more than once/);
  });
});
