import { server } from '~/_define/server.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { dedup } from '~/dedup/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { describe, expect, it } from 'vitest';
import type { AnyCapability } from '~/_define/capability.ts';
import { replay } from './capability.ts';
import type { ReplayPrimitive } from './replay.ts';

/** Built-in replay needs dedup + persistent sequence, so include them together. */
function replayReady() {
  return [dedup(), sequence({ persist: true })];
}

describe('replay capabilities', () => {
  it('installs built-in history replay with the replay feature flag', () => {
    const base = server({
      capabilities: [...replayReady(), replay.history({ retention: { maxAgeMs: 60_000 } })],
    });
    const definition = base.assemble({ handlers: [] });
    const primitive = definition.primitives.find((p) => p.__wskit === 'replay') as unknown as
      | ReplayPrimitive
      | undefined;
    expect(primitive?.options.type).toBe('history');
    expect(definition.__features?.has('replay')).toBe(true);
  });

  it('installs built-in snapshot replay', () => {
    const base = server({
      capabilities: [...replayReady(), replay.snapshot({})],
    });
    const primitive = base
      .assemble({ handlers: [] })
      .primitives.find((p) => p.__wskit === 'replay') as unknown as ReplayPrimitive;
    expect(primitive.options.type).toBe('snapshot');
  });

  it('refuses to boot built-in replay without dedup and persistent sequence', () => {
    const base = server({ capabilities: [replay.history()] });
    expect(() => compileHandlerDefinition(base.assemble({ handlers: [] }))).toThrow(/replay/);
  });

  it('registers a custom replay strategy with replay.custom() and base.replay()', () => {
    const base = server({ capabilities: [replay.custom()] });
    base.replay({ replay() {} });
    const definition = base.assemble({ handlers: [] });
    expect(definition.primitives.some((p) => p.__wskit === 'replayCustom')).toBe(true);
  });

  it('throws when base.replay() is used without the replay.custom() capability', () => {
    const base = server({});
    const escapeHatch = base as unknown as { replay(hooks: { replay(): void }): void };
    expect(() => escapeHatch.replay({ replay() {} })).toThrow(
      /base\.replay\(\) needs the replay\.custom\(\) capability/,
    );
  });

  it('throws when base.replay() is registered twice', () => {
    const base = server({ capabilities: [replay.custom()] });
    base.replay({ replay() {} });
    expect(() => base.replay({ replay() {} })).toThrow(/Duplicate replay hook/);
  });

  it('throws when replay.custom() is listed more than once', () => {
    expect(() =>
      server({ capabilities: [replay.custom(), replay.custom()] as AnyCapability[] }),
    ).toThrow(/replay\.custom\(\) is listed more than once/);
  });

  it('throws when more than one built-in replay strategy is listed', () => {
    expect(() =>
      server({
        capabilities: [...replayReady(), replay.history(), replay.snapshot()] as AnyCapability[],
      }),
    ).toThrow(/more than once/);
  });

  it('throws when built-in history replay and custom base.replay() are both configured', () => {
    const base = server({
      capabilities: [...replayReady(), replay.history(), replay.custom()],
    });
    base.replay({ replay() {} });
    expect(() => base.assemble({ handlers: [] })).toThrow(/both/);
  });

  it('throws when built-in snapshot replay and custom base.replay() are both configured', () => {
    const base = server({
      capabilities: [...replayReady(), replay.snapshot(), replay.custom()],
    });
    base.replay({ replay() {} });
    expect(() => base.assemble({ handlers: [] })).toThrow(/both/);
  });
});
