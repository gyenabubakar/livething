import { ReplayBuilder } from '~/replay/builder.ts';
import { describe, expect, it } from 'vitest';
import type { Primitive } from '~/primitive.ts';

function makeBuilder<M extends 'history' | 'snapshot' = 'history'>(type?: M) {
  const primitives: Primitive[] = [];
  const parent = { _primitives: primitives };
  return new ReplayBuilder<typeof parent, never, M>(parent, primitives, type);
}

describe('ReplayBuilder snapshot-only option guards', () => {
  it('_seal() throws when history mode has snapshotKey set', () => {
    const builder = makeBuilder();
    // Bypass `this` type guard to simulate runtime misuse.
    (builder as unknown as { snapshotKey: (fn: unknown) => unknown }).snapshotKey(
      (event: string) => event,
    );
    expect(() => builder._seal()).toThrow(/only apply when mode is 'snapshot'/);
    expect(() => builder._seal()).toThrow(/snapshotKey/);
  });

  it('_seal() throws when history mode has reduce set', () => {
    const builder = makeBuilder();
    (builder as unknown as { reduce: (fn: unknown) => unknown }).reduce(
      (_prev: unknown, next: unknown) => next,
    );
    expect(() => builder._seal()).toThrow(/only apply when mode is 'snapshot'/);
    expect(() => builder._seal()).toThrow(/reduce/);
  });

  it('_seal() does not throw when snapshot mode uses snapshotKey and reduce', () => {
    const builder = makeBuilder('snapshot');
    builder.snapshotKey((event) => event);
    builder.reduce((_prev, next) => next);
    expect(() => builder._seal()).not.toThrow();
  });

  it('extract() throws when history mode has snapshotKey set', () => {
    const builder = makeBuilder();
    (builder as unknown as { snapshotKey: (fn: unknown) => unknown }).snapshotKey(
      (event: string) => event,
    );
    expect(() => builder.extract()).toThrow(/only apply when mode is 'snapshot'/);
    expect(() => builder.extract()).toThrow(/snapshotKey/);
  });

  it('extract() throws when history mode has reduce set', () => {
    const builder = makeBuilder();
    (builder as unknown as { reduce: (fn: unknown) => unknown }).reduce(
      (_prev: unknown, next: unknown) => next,
    );
    expect(() => builder.extract()).toThrow(/only apply when mode is 'snapshot'/);
    expect(() => builder.extract()).toThrow(/reduce/);
  });

  it('extract() does not throw when snapshot mode uses both options', () => {
    const builder = makeBuilder('snapshot');
    builder.snapshotKey((event) => event);
    builder.reduce((_prev, next) => next);
    expect(() => builder.extract()).not.toThrow();
  });
});
