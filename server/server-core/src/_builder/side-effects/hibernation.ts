/**
 * Side-effect import that adds `.hibernation()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/hibernation'`
 * Adds method: `.hibernation(enabled?)`
 *
 * Calling `.hibernation()` opts the handler into platform hibernation support.
 * On platforms that support WebSocket hibernation (e.g. Cloudflare Durable
 * Objects), the runtime can sleep the worker process between messages and
 * wake it only when a message arrives, saving CPU cost. Without this primitive,
 * the connection is kept alive in memory continuously.
 *
 * Requires the `hibernation` platform capability.
 *
 * This file uses module augmentation (`declare module`) to teach TypeScript
 * about the new method and prototype patching to add the runtime implementation.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { hibernation as createHibernation } from '~/hibernation/hibernation.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { HibernationPrimitive } from '~/hibernation/hibernation.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * Module augmentation: adds `.hibernation()` to the builder interfaces so
 * TypeScript recognises the method after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Opt into platform hibernation support. The platform may pause the worker
     * between messages to save resources, waking it when the next message arrives.
     *
     * @param enabled Pass `false` to explicitly disable hibernation (rarely needed).
     *   Defaults to `true`.
     */
    hibernation(enabled?: boolean): ServerBuilder<NextState<TState, HibernationPrimitive>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Opt into platform hibernation support. The platform may pause the worker
     * between messages to save resources, waking it when the next message arrives.
     *
     * @param enabled Pass `false` to explicitly disable hibernation (rarely needed).
     *   Defaults to `true`.
     */
    hibernation(enabled?: boolean): GroupBuilder<NextState<TState, HibernationPrimitive>>;
  }
}

/** Runtime implementation of `.hibernation()` for `ServerBuilder`. */
ServerBuilder.prototype.hibernation = function (enabled?: boolean) {
  this._primitives.push(createHibernation(enabled) as unknown as Primitive);
  return this;
};

/** Runtime implementation of `.hibernation()` for `GroupBuilder`. */
GroupBuilder.prototype.hibernation = function (enabled?: boolean) {
  this._primitives.push(createHibernation(enabled) as unknown as Primitive);
  return this;
};

/** @internal Side-effect registration marker. */
export const __sideEffect_hibernation = true;
