import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { generate, nudge, start, stream } from './stream.ts';

describe('stream primitives', () => {
  it('creates start declarations with and without a schema validator', () => {
    const plainStart = start('ai', undefined, { broadcast: true });
    const schemaStart = start('ai', v.object({ prompt: v.string() }));

    expect(plainStart).toEqual({
      event: 'ai',
      validator: undefined,
      broadcast: true,
    });
    expect(schemaStart.event).toBe('ai');
    expect(schemaStart.validator).toBeDefined();
  });

  it('creates nudge declarations with and without validators', () => {
    const plain = nudge('cancel');
    const parsed = nudge('add-context', v.object({ text: v.string() }));

    expect(plain).toEqual({ event: 'cancel', validator: undefined });
    expect(parsed.event).toBe('add-context');
    expect(parsed.validator).toBeDefined();
  });

  it('creates paired stream and generate primitives keyed by the trigger event', () => {
    const streamDeclaration = stream(
      start('ai', v.object({ prompt: v.string() }), { broadcast: true }),
      nudge('cancel'),
    );
    const generator = vi.fn(async function* () {
      yield { token: 'hi' };
    });
    const generateDeclaration = generate(streamDeclaration, generator);

    expect(streamDeclaration.__wskit).toBe('stream');
    expect(streamDeclaration.__identity[1]).toBe('ai');
    expect(streamDeclaration.broadcast).toBe(true);
    expect(streamDeclaration.nudges).toHaveLength(1);
    expect(generateDeclaration.__wskit).toBe('stream-generate');

    expect(generateDeclaration.__identity[1]).toBe('ai');
    expect(generateDeclaration.stream).toBe(streamDeclaration);
    expect(generateDeclaration.generator).toBe(generator);
  });
});
