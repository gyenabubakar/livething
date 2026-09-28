import { server } from '~/_define/server.ts';
import { compileServerDefinition } from '~/_engine/compile/compile.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { describe, expect, it } from 'vitest';
import type { AnyCapability } from '~/_define/capability.ts';
import { replay } from './capability.ts';
import type { ReplayPrimitive } from './replay.ts';

/** Built-in and custom replay need dedup + persistent sequence, so include them together. */
function replayReady() {
  return [dedup(), sequence({ persist: true })];
}

describe('replay capabilities', () => {
  it('installs built-in history replay with the replay feature flag', () => {
    const base = server({
      capabilities: [...replayReady(), replay.history({ retention: { maxAgeMs: 60_000 } })],
    });
    const definition = base.assemble({ handlers: [] });
    const primitive = definition.primitives.find((p) => p.__livething === 'replay') as unknown as
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
      .primitives.find((p) => p.__livething === 'replay') as unknown as ReplayPrimitive;
    expect(primitive.options.type).toBe('snapshot');
  });

  it('refuses to boot built-in replay without dedup and persistent sequence', () => {
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

  it('registers a custom replay strategy with replay.custom() and base.replay()', () => {
    const base = server({ capabilities: [...replayReady(), replay.custom()] });
    base.replay({ replay() {} });
    const definition = base.assemble({ handlers: [] });
    expect(definition.primitives.some((p) => p.__livething === 'replayCustom')).toBe(true);
    expect(() => compileServerDefinition(definition)).not.toThrow();
  });

  it('refuses to boot replay.custom() without dedup', () => {
    const base = server({ capabilities: [sequence({ persist: true }), replay.custom()] });
    base.replay({ replay() {} });
    expect(() => compileServerDefinition(base.assemble({ handlers: [] }))).toThrow(
      "[livething] replay.custom() needs the dedup() capability. Custom replay hooks get every broadcast's msg.wire.messageId from dedup. List dedup() in server({ capabilities: [...] }).",
    );
  });

  it('refuses to boot replay.custom() without a sequence', () => {
    const base = server({ capabilities: [dedup(), replay.custom()] });
    base.replay({ replay() {} });
    expect(() => compileServerDefinition(base.assemble({ handlers: [] }))).toThrow(
      "[livething] replay.custom() needs a persistent sequence. Custom replay hooks get every broadcast's msg.wire.deliverySeq from sequence, and a stored seq only stays valid across restarts when sequence persists. List sequence({ persist: true }) in server({ capabilities: [...] }) instead of sequence().",
    );
  });

  it('refuses to boot replay.custom() with a sequence that does not persist', () => {
    const base = server({ capabilities: [dedup(), sequence(), replay.custom()] });
    base.replay({ replay() {} });
    expect(() => compileServerDefinition(base.assemble({ handlers: [] }))).toThrow(
      /replay\.custom\(\) needs a persistent sequence/,
    );
  });

  it('refuses to boot replay.custom() without dedup even when no base.replay() is registered', () => {
    const base = server({ capabilities: [replay.custom()] });
    expect(() => compileServerDefinition(base.assemble({ handlers: [] }))).toThrow(
      /replay\.custom\(\) needs the dedup\(\) capability/,
    );
  });

  it('refuses to boot a channel custom replay without the replay.custom() dependencies', () => {
    const base = server({ capabilities: [channels(), replay.custom()] });
    const room = base.channel('room');
    room.replay({ replay() {} });
    expect(() => compileServerDefinition(base.assemble({ handlers: [room] }))).toThrow(
      /replay\.custom\(\) needs the dedup\(\) capability/,
    );
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
