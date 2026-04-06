import { h, isHandled, unwrapHandled } from '~/h.ts';
import { describe, expect, it } from 'vitest';

describe('h', () => {
  it('wraps a handler with a stable tag', () => {
    const handler = async () => {};
    const wrapped = h(handler);

    expect(wrapped.__wskit).toBe('h');
    expect(wrapped.fn).toBe(handler);
  });

  it('detects wrapped handlers', () => {
    expect(isHandled(h(async () => {}))).toBe(true);
    expect(isHandled(async () => {})).toBe(false);
  });

  it('unwraps both raw and wrapped handlers', () => {
    const handler = async () => {};

    expect(unwrapHandled(handler)).toBe(handler);
    expect(unwrapHandled(h(handler))).toBe(handler);
  });
});
