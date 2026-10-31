import { LiveThingConfigError } from '@livething/core';
import { keepalive } from '~/keepalive/keepalive.ts';
import { describe, expect, it } from 'vitest';

const MAX_TIMER_DELAY = 2 ** 31 - 1;

describe('keepalive() timer limits', () => {
  it('throws for a pingIntervalMs longer than a timer can hold', () => {
    expect(() =>
      keepalive({ pingIntervalMs: MAX_TIMER_DELAY + 1, idleTimeoutMs: MAX_TIMER_DELAY + 2 }),
    ).toThrow(LiveThingConfigError);
  });

  it('throws for an idleTimeoutMs longer than a timer can hold', () => {
    expect(() => keepalive({ pingIntervalMs: 30_000, idleTimeoutMs: MAX_TIMER_DELAY + 1 })).toThrow(
      LiveThingConfigError,
    );
  });

  it('accepts the longest values a timer can hold', () => {
    expect(() =>
      keepalive({ pingIntervalMs: MAX_TIMER_DELAY - 1, idleTimeoutMs: MAX_TIMER_DELAY }),
    ).not.toThrow();
  });
});
