import { generate, nudge, start, stream } from '~/primitives/stream.ts';
import { t } from '~/t.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('stream', () => {
  it('produces correct tag and kind', () => {
    const p = stream(
      start('ask-ai'),
      generate(
        async function* () {
          yield { text: 'hello' };
        },
        { chunks: t<{ text: string }>() },
      ),
    );
    expect(p.__wskit).toBe('stream');
    expect(p.__kind).toBe('handler');
  });

  it('produces compound identity keyed by event name', () => {
    const p = stream(
      start('ask-ai'),
      generate(
        async function* () {
          yield {};
        },
        { chunks: t() },
      ),
    );
    expect(p.__identity[1]).toBe('ask-ai');
  });

  it('stores event name from start()', () => {
    const p = stream(
      start('generate-report'),
      generate(
        async function* () {
          yield {};
        },
        { chunks: t() },
      ),
    );
    expect(p.event).toBe('generate-report');
  });

  it('stores the generator function', () => {
    async function* gen() {
      yield { text: 'hi' };
    }
    const p = stream(start('ask-ai'), generate(gen, { chunks: t<{ text: string }>() }));
    expect(p.generator).toBe(gen);
  });

  it('defaults broadcast to false', () => {
    const p = stream(
      start('ask-ai'),
      generate(
        async function* () {
          yield {};
        },
        { chunks: t() },
      ),
    );
    expect(p.broadcast).toBe(false);
  });

  it('stores broadcast from start() options', () => {
    const p = stream(
      start('ask-ai', undefined, { broadcast: true }),
      generate(
        async function* () {
          yield {};
        },
        { chunks: t() },
      ),
    );
    expect(p.broadcast).toBe(true);
  });
});

describe('stream with validators', () => {
  it('stores a valibot trigger validator', () => {
    const schema = v.object({ prompt: v.string() });
    const p = stream(
      start('ask-ai', schema),
      generate(
        async function* (_ctx, payload) {
          const _prompt: string = payload.prompt;
          void _prompt;
          yield { text: 'token' };
        },
        { chunks: t<{ text: string }>() },
      ),
    );
    expect(p.validator).toBe(schema);
  });

  it('stores a zod trigger validator', () => {
    const schema = z.object({ prompt: z.string() });
    const p = stream(
      start('ask-ai', schema),
      generate(
        async function* (_ctx, payload) {
          const _prompt: string = payload.prompt;
          void _prompt;
          yield { text: 'token' };
        },
        { chunks: t<{ text: string }>() },
      ),
    );
    expect(p.validator).toBe(schema);
  });

  it('stores a parse function trigger validator', () => {
    function validate(p: unknown) {
      return p as { prompt: string };
    }
    const p = stream(
      start('ask-ai', validate),
      generate(
        async function* () {
          yield { text: 'token' };
        },
        { chunks: t<{ text: string }>() },
      ),
    );
    expect(p.validator).toBe(validate);
  });

  it('stores no validator when omitted', () => {
    const p = stream(
      start('ask-ai'),
      generate(
        async function* () {
          yield {};
        },
        { chunks: t() },
      ),
    );
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

describe('stream with nudges', () => {
  it('stores nudge declarations in order before generate()', () => {
    const p = stream(
      start('ask-ai'),
      nudge('cancel'),
      nudge('add-context'),
      generate(
        async function* () {
          yield {};
        },
        { chunks: t() },
      ),
    );
    expect(p.nudges).toHaveLength(2);
    expect(p.nudges[0]!.event).toBe('cancel');
    expect(p.nudges[1]!.event).toBe('add-context');
  });

  it('stores empty nudges when none are provided', () => {
    const p = stream(
      start('ask-ai'),
      generate(
        async function* () {
          yield {};
        },
        { chunks: t() },
      ),
    );
    expect(p.nudges).toHaveLength(0);
  });
});

describe('stream PrimitiveRef', () => {
  it('factory has __key for dependency references', () => {
    expect(typeof stream.__key).toBe('symbol');
  });

  it('has empty dependencies and requires', () => {
    const p = stream(
      start('ask-ai'),
      generate(
        async function* () {
          yield {};
        },
        { chunks: t() },
      ),
    );
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });
});
