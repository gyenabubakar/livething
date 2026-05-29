import { error } from '@wskit/core';
import { plugin } from '~/plugins/plugin.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

const Analytics = plugin('acme:analytics', {
  errors: {
    denied: error('denied', v.object({ reason: v.string() })),
  },
  setup: () => () => ({}),
});

describe('plugin error namespacing', () => {
  it('namespaces the error code to __<id>:<name> on the exposed factory', () => {
    expect(Analytics.errors.denied.code).toBe('__acme:analytics:denied');
  });

  it('thrown errors carry the namespaced code and still validate their detail', () => {
    const err = Analytics.errors.denied({ reason: 'quota' });
    expect(err.code).toBe('__acme:analytics:denied');
    expect(err.detail).toEqual({ reason: 'quota' });
    expect(Analytics.errors.denied.matches(err)).toBe(true);
  });

  it('the instance carries the same namespaced map the engine registers from', () => {
    const instance = Analytics();
    expect(Object.values(instance.errors ?? {}).map((def) => def.code)).toEqual([
      '__acme:analytics:denied',
    ]);
  });
});
