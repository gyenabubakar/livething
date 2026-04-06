import { chunks, generate, nudge, start, stream } from '~/stream/stream.ts';
import { t } from '~/t.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('stream', () => {
  it('produces correct tag and kind', () => {
    const p = stream(start('ask-ai'), chunks(t<{ text: string }>()));
    expect(p.__wskit).toBe('stream');
    expect(p.__kind).toBe('handler');
  });

  it('produces compound identity keyed by event name', () => {
    const p = stream(start('ask-ai'), chunks(t<{ text: string }>()));
    expect(p.__identity[1]).toBe('ask-ai');
  });

  it('stores event name from start()', () => {
    const p = stream(start('generate-report'), chunks(t<{ text: string }>()));
    expect(p.event).toBe('generate-report');
  });

  it('stores the chunk marker', () => {
    const marker = t<{ text: string }>();
    const p = stream(start('ask-ai'), chunks(marker));
    expect(p.chunks).toBe(marker);
  });

  it('different stream events have different identities with the same primitive key', () => {
    const a = stream(start('ask-ai'), chunks(t<{ text: string }>()));
    const b = stream(start('summarize-doc'), chunks(t<{ text: string }>()));
    expect(a.__identity[0]).toBe(b.__identity[0]);
    expect(a.__identity[1]).toBe('ask-ai');
    expect(b.__identity[1]).toBe('summarize-doc');
  });

  it('defaults broadcast to false', () => {
    const p = stream(start('ask-ai'), chunks(t<{ text: string }>()));
    expect(p.broadcast).toBe(false);
  });

  it('stores broadcast from start() options', () => {
    const p = stream(
      start('ask-ai', undefined, { broadcast: true }),
      chunks(t<{ text: string }>()),
    );
    expect(p.broadcast).toBe(true);
  });

  it('stores nudge declarations in order', () => {
    const p = stream(
      start('ask-ai'),
      chunks(t<{ text: string }>()),
      nudge('cancel'),
      nudge('add-context'),
    );
    expect(p.nudges).toHaveLength(2);
    expect(p.nudges[0]!.event).toBe('cancel');
    expect(p.nudges[1]!.event).toBe('add-context');
  });

  it('stores empty nudges when none are provided', () => {
    const p = stream(start('ask-ai'), chunks(t<{ text: string }>()));
    expect(p.nudges).toHaveLength(0);
  });
});

describe('stream with validators', () => {
  it('stores a valibot trigger validator', () => {
    const schema = v.object({ prompt: v.string() });
    const p = stream(start('ask-ai', schema), chunks(t<{ text: string }>()));
    expect(p.validator).toBe(schema);
  });

  it('stores a zod trigger validator', () => {
    const schema = z.object({ prompt: z.string() });
    const p = stream(start('ask-ai', schema), chunks(t<{ text: string }>()));
    expect(p.validator).toBe(schema);
  });

  it('stores a parse function trigger validator', () => {
    function validate(p: unknown) {
      return p as { prompt: string };
    }
    const p = stream(start('ask-ai', validate), chunks(t<{ text: string }>()));
    expect(p.validator).toBe(validate);
  });

  it('stores no validator when omitted', () => {
    const p = stream(start('ask-ai'), chunks(t<{ text: string }>()));
    expect(p.validator).toBeUndefined();
  });
});

describe('start', () => {
  it('creates declaration with event name', () => {
    const s = start('ask-ai');
    expect(s.event).toBe('ask-ai');
    expect(s.validator).toBeUndefined();
  });

  it('stores broadcast option', () => {
    const s = start('ask-ai', undefined, { broadcast: true });
    expect(s.broadcast).toBe(true);
  });
});

describe('chunks', () => {
  it('stores the provided chunk marker', () => {
    const marker = t<{ text: string }>();
    const c = chunks(marker);
    expect(c.chunks).toBe(marker);
  });
});

describe('nudge', () => {
  it('creates declaration with event name', () => {
    const n = nudge('cancel');
    expect(n.event).toBe('cancel');
    expect(n.validator).toBeUndefined();
  });

  it('creates declaration with parse function validator', () => {
    function validate(p: unknown) {
      return p as { context: string };
    }
    const n = nudge('add-context', validate);
    expect(n.event).toBe('add-context');
    expect(n.validator).toBe(validate);
  });

  it('creates declaration with valibot validator', () => {
    const schema = v.object({ context: v.string() });
    const n = nudge('add-context', schema);
    expect(n.event).toBe('add-context');
    expect(n.validator).toBe(schema);
  });

  it('creates declaration with zod validator', () => {
    const schema = z.object({ context: z.string() });
    const n = nudge('add-context', schema);
    expect(n.event).toBe('add-context');
    expect(n.validator).toBe(schema);
  });
});

describe('generate', () => {
  const aiStream = stream(
    start('ask-ai', (p: unknown) => p as { prompt: string }),
    chunks(t<{ text: string }>()),
    nudge('cancel'),
  );

  it('produces correct tag and kind', () => {
    const p = generate(aiStream, async function* () {
      yield { text: 'hello' };
    });
    expect(p.__wskit).toBe('generate');
    expect(p.__kind).toBe('handler');
  });

  it('produces compound identity keyed by event name', () => {
    const p = generate(aiStream, async function* () {
      yield { text: 'hi' };
    });
    expect(p.__identity[1]).toBe('ask-ai');
  });

  it('stores the generator function', () => {
    async function* gen() {
      yield { text: 'hi' };
    }
    const p = generate(aiStream, gen);
    expect(p.generator).toBe(gen);
  });

  it('stores the stream contract', () => {
    const p = generate(aiStream, async function* () {
      yield { text: 'hi' };
    });
    expect(p.stream).toBe(aiStream);
    expect(p.event).toBe('ask-ai');
    expect(p.chunks).toBe(aiStream.chunks);
  });

  it('different generate events have different identities with the same primitive key', () => {
    const otherStream = stream(start('summarize-doc'), chunks(t<{ text: string }>()));
    const a = generate(aiStream, async function* () {
      yield { text: 'hi' };
    });
    const b = generate(otherStream, async function* () {
      yield { text: 'hi' };
    });
    expect(a.__identity[0]).toBe(b.__identity[0]);
    expect(a.__identity[1]).toBe('ask-ai');
    expect(b.__identity[1]).toBe('summarize-doc');
  });

  it('instances have empty dependencies and requires', () => {
    const p = generate(aiStream, async function* () {
      yield { text: 'hi' };
    });
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });
});

describe('PrimitiveRef', () => {
  it('stream factory has __key for dependency references', () => {
    expect(typeof stream.__key).toBe('symbol');
  });

  it('generate factory has __key for dependency references', () => {
    expect(typeof generate.__key).toBe('symbol');
  });

  it('stream instance has empty dependencies and requires', () => {
    const p = stream(start('ask-ai'), chunks(t<{ text: string }>()));
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });
});
