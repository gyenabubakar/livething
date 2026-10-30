import { server } from '~/_define/server.ts';
import { describe, expect, it } from 'vitest';
import { sequence } from './capability.ts';
import type { SequencePrimitive } from './sequence.ts';

describe('sequence() capability', () => {
  it('adds the sequence primitive', () => {
    const base = server({ capabilities: [sequence()] });
    const definition = base.assemble({ handlers: [] });
    expect(definition.primitives.some((p) => p.__livething === 'sequence')).toBe(true);
  });

  it('carries the persist option onto the primitive', () => {
    const base = server({
      capabilities: [sequence({ persist: true })],
    });
    const primitive = base
      .assemble({ handlers: [] })
      .primitives.find((p) => p.__livething === 'sequence') as unknown as SequencePrimitive;
    expect(primitive.persist).toBe(true);
  });
});
