import { server } from '~/_define/server.ts';
import { compileServerDefinition } from '~/_engine/compile/compile.ts';
import { dedup } from '~/dedup/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { describe, expect, it } from 'vitest';
import type { AnyCapability } from '~/_define/capability.ts';
import { replay } from './capability.ts';
import type { ReplayPrimitive } from './replay.ts';

/** Replay needs dedup + persistent sequence, so include them together. */
function replayReady() {
  return [dedup(), sequence({ persist: true })];
}

describe('replay capabilities', () => {
  it('installs history replay', () => {
    const base = server({
      capabilities: [...replayReady(), replay.history({ retention: { maxAgeMs: 60_000 } })],
    });
    const definition = base.assemble({ handlers: [] });
    const primitive = definition.primitives.find((p) => p.__livething === 'replay') as unknown as
      | ReplayPrimitive
      | undefined;
    expect(primitive).toBeDefined();
  });

  it('installs snapshot replay', () => {
    const base = server({
      capabilities: [...replayReady(), replay.snapshot({})],
    });
    const primitive = base
      .assemble({ handlers: [] })
      .primitives.find((p) => p.__livething === 'replay') as unknown as ReplayPrimitive;
    expect(primitive).toBeDefined();
  });

  it('refuses to boot replay without dedup and persistent sequence', () => {
    const base = server({ capabilities: [replay.history()] });
    expect(() => compileServerDefinition(base.assemble({ handlers: [] }))).toThrow(/replay/);
  });

  it('names the real capability call when the sequence is not persistent', () => {
    const base = server({ capabilities: [dedup(), sequence(), replay.history()] });
    expect(() => compileServerDefinition(base.assemble({ handlers: [] }))).toThrow(
      'List sequence({ persist: true }) in server({ capabilities: [...] }) instead of sequence().',
    );
  });

  it('checks the persistent-sequence rule only at compile, not again in the primitive', () => {
    const base = server({ capabilities: [dedup(), sequence(), replay.history()] });
    const primitive = base
      .assemble({ handlers: [] })
      .primitives.find((p) => p.__livething === 'replay');
    expect(primitive?.__validate).toBeUndefined();
  });

  it('throws when more than one replay strategy is listed', () => {
    expect(() =>
      server({
        capabilities: [...replayReady(), replay.history(), replay.snapshot()] as AnyCapability[],
      }),
    ).toThrow(/more than once/);
  });
});
