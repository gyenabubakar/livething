import { server } from '~/_define/server.ts';
import { describe, expect, it } from 'vitest';
import { dedup } from './capability.ts';

describe('dedup() capability', () => {
  it('adds the dedup primitive and the dedup feature flag', () => {
    const base = server({ capabilities: [dedup({ cap: 128 })] });
    const definition = base.assemble({ handlers: [] });
    expect(definition.primitives.some((p) => p.__wskit === 'dedup')).toBe(true);
    expect(definition.__features?.has('dedup')).toBe(true);
  });
});
