import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { describe, expect, it } from 'vitest';
import { dedup } from './capability.ts';

describe('dedup() capability', () => {
  it('adds the dedup primitive and the dedup feature flag', () => {
    const base = define({ env: t<Record<string, never>>(), capabilities: [dedup({ cap: 128 })] });
    const handler = base.assemble();
    expect(handler.primitives.some((p) => p.__wskit === 'dedup')).toBe(true);
    expect(handler.__features?.has('dedup')).toBe(true);
  });
});
