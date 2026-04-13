/**
 * Side-effect import that adds `.sequence()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/sequence'`
 * Adds method: `.sequence(options?)`
 *
 * Calling `.sequence()` registers the sequence primitive, which stamps every
 * outgoing message with a monotonically increasing `_seq` number. Clients can
 * use this number to detect message gaps and request a replay.
 *
 * When `options.persist` is `true`, the counter is stored in SQLite so it
 * survives server restarts. Requires the `storage` platform capability in that
 * case.
 *
 * This file uses module augmentation (`declare module`) to teach TypeScript
 * about the new method and prototype patching to add the runtime implementation.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { sequence as createSequence } from '~/sequence/sequence.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';
import type { SequenceOptions, SequencePrimitive } from '~/sequence/sequence.ts';

/**
 * Module augmentation: adds `.sequence()` to the builder interfaces so
 * TypeScript recognises the method after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Register the sequence primitive. Adds a `_seq` field to every outgoing
     * message payload so clients can detect out-of-order or missing messages.
     *
     * @param options.persist When `true`, the counter persists across restarts
     *   (requires `storage`). Defaults to `false`.
     */
    sequence(options?: SequenceOptions): ServerBuilder<NextState<TState, SequencePrimitive>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Register the sequence primitive. Adds a `_seq` field to every outgoing
     * message payload so clients can detect out-of-order or missing messages.
     *
     * @param options.persist When `true`, the counter persists across restarts
     *   (requires `storage`). Defaults to `false`.
     */
    sequence(options?: SequenceOptions): GroupBuilder<NextState<TState, SequencePrimitive>>;
  }
}

/** Runtime implementation of `.sequence()` for `ServerBuilder`. */
ServerBuilder.prototype.sequence = function (options?: SequenceOptions) {
  this._primitives.push(createSequence(options) as unknown as Primitive);
  return this;
};

/** Runtime implementation of `.sequence()` for `GroupBuilder`. */
GroupBuilder.prototype.sequence = function (options?: SequenceOptions) {
  this._primitives.push(createSequence(options) as unknown as Primitive);
  return this;
};

/** @internal Side-effect registration marker. */
export const __sideEffect_sequence = true;
