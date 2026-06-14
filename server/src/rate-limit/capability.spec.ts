import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { requests } from '~/request/capability.ts';
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
      env: t<Record<string, never>>(),
      capabilities: [rateLimit({ max: 100 })],
    });
    expect(interceptCount(base.assemble())).toBe(1);
  });

  it('installs the intercept from a per-handler override with no global default', () => {
    const base = define({ env: t<Record<string, never>>(), capabilities: [rateLimit()] });
    const handler = base.on('expensive', {
      input: v.object({}),
      rateLimit: { enabled: true, max: 1, windowMs: 10_000 },
      run() {},
    });
    expect(interceptCount(base.assemble(handler))).toBe(1);
  });

  it('collects a per-handler override from a request as well as an on handler', () => {
    const base = define({
      env: t<Record<string, never>>(),
      capabilities: [rateLimit(), requests()],
    });
    const ask = base.request('ask', {
      input: v.object({}),
      rateLimit: { enabled: true, max: 2 },
      run() {
        return {};
      },
    });
    expect(interceptCount(base.assemble(ask))).toBe(1);
  });

  it('still installs the intercept when a global rule is set and one handler disables its limit', () => {
    const base = define({
      env: t<Record<string, never>>(),
      capabilities: [rateLimit({ max: 100 })],
    });
    const free = base.on('free', {
      input: v.object({}),
      rateLimit: { enabled: false },
      run() {},
    });
    expect(interceptCount(base.assemble(free))).toBe(1);
  });

  it('adds no rate-limit intercept when the capability has no global rule and no overrides', () => {
    const base = define({ env: t<Record<string, never>>(), capabilities: [rateLimit()] });
    const handler = base.on('plain', { input: v.object({}), run() {} });
    expect(interceptCount(base.assemble(handler))).toBe(0);
  });

  it('throws when a handler sets a rateLimit override but the capability is not listed', () => {
    const base = define({ env: t<Record<string, never>>() });
    const handler = base.on('plain', {
      input: v.object({}),
      rateLimit: { enabled: true, max: 1 },
      run() {},
    });
    expect(() => base.assemble(handler)).toThrow(
      /per-handler rateLimit override needs the rateLimit\(\) capability/,
    );
  });

  it('throws when rateLimit() is listed more than once', () => {
    const base = define({
      env: t<Record<string, never>>(),
      capabilities: [rateLimit({ max: 10 }), rateLimit({ max: 20 })],
    });
    expect(() => base.assemble()).toThrow(/rateLimit\(\) is listed more than once/);
  });
});
