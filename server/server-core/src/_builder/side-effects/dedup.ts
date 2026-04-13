/**
 * Side-effect import that adds `.dedup()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/dedup'`
 * Adds method: `.dedup()`
 *
 * Calling `.dedup()` registers the deduplication primitive, which stamps every
 * outgoing message with a unique `_messageId` string. Clients can store
 * received IDs and discard any message whose `_messageId` has already been
 * processed, protecting against duplicate deliveries caused by retries or
 * replay.
 *
 * This file uses module augmentation (`declare module`) to teach TypeScript
 * about the new method and prototype patching to add the runtime implementation.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { dedup as createDedup } from '~/dedup/dedup.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { DedupPrimitive } from '~/dedup/dedup.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * Module augmentation: adds `.dedup()` to the builder interfaces so TypeScript
 * recognises the method after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Register the deduplication primitive. Adds a unique `_messageId` field to
     * every outgoing message so clients can discard duplicate deliveries.
     */
    dedup(): ServerBuilder<NextState<TState, DedupPrimitive>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Register the deduplication primitive. Adds a unique `_messageId` field to
     * every outgoing message so clients can discard duplicate deliveries.
     */
    dedup(): GroupBuilder<NextState<TState, DedupPrimitive>>;
  }
}

/** Runtime implementation of `.dedup()` for `ServerBuilder`. */
ServerBuilder.prototype.dedup = function () {
  this._primitives.push(createDedup() as unknown as Primitive);
  return this;
};

/** Runtime implementation of `.dedup()` for `GroupBuilder`. */
GroupBuilder.prototype.dedup = function () {
  this._primitives.push(createDedup() as unknown as Primitive);
  return this;
};

/** @internal Side-effect registration marker. */
export const __sideEffect_dedup = true;
