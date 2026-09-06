import { define } from '~/_define/define.ts';
import { describe, expect, it } from 'vitest';
import { dedup } from './capability.ts';

describe('dedup() capability', () => {
  it('adds the dedup primitive and the dedup feature flag', () => {
    const base = define({ capabilities: [dedup({ cap: 128 })] });
    const handler = base.assemble({ handlers: [] });
    expect(handler.primitives.some((p) => p.__wskit === 'dedup')).toBe(true);
    expect(handler.__features?.has('dedup')).toBe(true);
  });
});
