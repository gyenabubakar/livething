import { define } from '~/_define/define.ts';
import { clientRequests } from '~/request/client-requests.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { ServerDefinition } from '~/server-definition.ts';
import { rateLimit } from './capability.ts';

function interceptCount(handler: ServerDefinition): number {
  return handler.primitives.filter((p) => p.__wskit === 'intercept').length;
}

describe('rateLimit() capability', () => {
  it('installs a rate-limit intercept from the global rule', () => {
    const base = define({
      capabilities: [rateLimit({ max: 100 })],
    });
    expect(interceptCount(base.assemble({ handlers: [] }))).toBe(1);
  });

  it('installs the intercept from a per-handler override with no global default', () => {
    const base = define({ capabilities: [rateLimit()] });
    const handler = base.on('expensive', {
      input: v.object({}),
      rateLimit: { enabled: true, max: 1, windowMs: 10_000 },
      run() {},
    });
    expect(interceptCount(base.assemble({ handlers: [handler] }))).toBe(1);
  });

  it('collects a per-handler override from a request as well as an on handler', () => {
    const base = define({
      capabilities: [rateLimit(), clientRequests()],
    });
    const ask = base.request('ask', {
      input: v.object({}),
      rateLimit: { enabled: true, max: 2 },
      run() {
        return {};
      },
    });
    expect(interceptCount(base.assemble({ handlers: [ask] }))).toBe(1);
  });

  it('still installs the intercept when a global rule is set and one handler disables its limit', () => {
    const base = define({
      capabilities: [rateLimit({ max: 100 })],
    });
    const free = base.on('free', {
      input: v.object({}),
      rateLimit: { enabled: false },
      run() {},
    });
    expect(interceptCount(base.assemble({ handlers: [free] }))).toBe(1);
  });

  it('adds no rate-limit intercept when the capability has no global rule and no overrides', () => {
    const base = define({ capabilities: [rateLimit()] });
    const handler = base.on('plain', { input: v.object({}), run() {} });
    expect(interceptCount(base.assemble({ handlers: [handler] }))).toBe(0);
  });

  it('throws at assemble when a handler smuggles a rateLimit override past the type gate without the capability', () => {
    // The type gate (RateLimitField) makes `rateLimit` a compile error here; the
    // cast bypasses it to prove the assemble-time throw is still wired as
    // defense-in-depth for code that sidesteps the types.
    const base = define({});
    const handler = base.on('plain', {
      input: v.object({}),
      ...({ rateLimit: { enabled: true, max: 1 } } as object),
      run() {},
    });
    expect(() => base.assemble({ handlers: [handler] })).toThrow(
      /per-handler rateLimit override needs the rateLimit\(\) capability/,
    );
  });

  it('throws when rateLimit() is listed more than once', () => {
    const base = define({
      capabilities: [rateLimit({ max: 10 }), rateLimit({ max: 20 })],
    });
    expect(() => base.assemble({ handlers: [] })).toThrow(/rateLimit\(\) is listed more than once/);
  });
});
