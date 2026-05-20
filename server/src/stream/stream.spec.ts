import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { generate, nudge, start, stream } from './stream.ts';

describe('stream primitives', () => {
  it('creates start declarations from parse functions and standard schema validators', () => {
    const parseStart = start('ai', (value: unknown) => value as { prompt: string }, {
      broadcast: true,
    });
    const schemaStart = start('ai', v.object({ prompt: v.string() }));

    expect(parseStart).toEqual({
      event: 'ai',
      validator: expect.any(Function),
      broadcast: true,
    });
    expect(schemaStart.event).toBe('ai');
    expect(schemaStart.validator).toBeDefined();
  });

  it('creates nudge declarations with and without validators', () => {
    const plain = nudge('cancel');
    const parsed = nudge('add-context', (value: unknown) => value as { text: string });

    expect(plain).toEqual({ event: 'cancel', validator: undefined });
    expect(parsed).toEqual({ event: 'add-context', validator: expect.any(Function) });
  });

  it('creates paired stream and generate primitives keyed by the trigger event', () => {
    const streamDecl = stream(
      start('ai', (value: unknown) => value as { prompt: string }, { broadcast: true }),
      nudge('cancel'),
    );
    const generator = vi.fn(async function* () {
      yield { token: 'hi' };
    });
    const generateDecl = generate(streamDecl, generator);

    expect(streamDecl.__wskit).toBe('stream');
    expect(streamDecl.__identity[1]).toBe('ai');
    expect(streamDecl.broadcast).toBe(true);
    expect(streamDecl.nudges).toHaveLength(1);
    expect(generateDecl.__wskit).toBe('stream-generate');
    expect(generateDecl.__identity[1]).toBe('ai');
    expect(generateDecl.stream).toBe(streamDecl);
    expect(generateDecl.generator).toBe(generator);
  });
});
