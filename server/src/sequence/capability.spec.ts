import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { describe, expect, it } from 'vitest';
import { sequence } from './capability.ts';
import type { SequencePrimitive } from './sequence.ts';

describe('sequence() capability', () => {
  it('adds the sequence primitive and the sequence feature flag', () => {
    const base = define({ env: t<Record<string, never>>(), capabilities: [sequence()] });
    const handler = base.assemble({ handlers: [] });
    expect(handler.primitives.some((p) => p.__wskit === 'sequence')).toBe(true);
    expect(handler.__features?.has('sequence')).toBe(true);
  });

  it('carries the persist option onto the primitive', () => {
    const base = define({
      env: t<Record<string, never>>(),
      capabilities: [sequence({ persist: true, batchSize: 5 })],
    });
    const primitive = base
      .assemble({ handlers: [] })
      .primitives.find((p) => p.__wskit === 'sequence') as unknown as SequencePrimitive;
    expect(primitive.persist).toBe(true);
    expect(primitive.batchSize).toBe(5);
  });
});
