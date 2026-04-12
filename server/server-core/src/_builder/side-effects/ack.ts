/**
 * Side-effect import that adds `.ack()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/ack'`
 * Adds method: `.ack()`
 *
 * Calling `.ack()` on a builder registers the acknowledgement primitive, which
 * adds an `ack()` method to every connection handler context. Handlers can call
 * `ctx.ack()` to tell the client that the most recently received message was
 * processed successfully.
 *
 * This file uses two TypeScript techniques:
 * 1. **Module augmentation** (`declare module`) — teaches the TypeScript compiler
 *    that `ServerBuilder` and `GroupBuilder` have a new `.ack()` method.
 * 2. **Prototype patching** — adds the real runtime implementation of `.ack()`
 *    to both builder classes so it works when called.
 *
 * Both are needed because TypeScript's type system and JavaScript's runtime are
 * separate: `declare module` only affects types, and `prototype.ack` only adds
 * the runtime behavior.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { ack as createAck } from '~/ack/ack.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { AckPrimitive } from '~/ack/ack.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * Module augmentation: adds `.ack()` to the builder interfaces so TypeScript
 * knows the method exists after this file is imported.
 *
 * The return type `ServerBuilder<NextState<TState, AckPrimitive>>` threads the
 * `AckPrimitive` into the builder's type-level state so that downstream types
 * (e.g. the generated `ctx`) reflect that ack is now available.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /** Register the ack primitive. Adds `ctx.ack()` to all handler contexts in this scope. */
    ack(): ServerBuilder<NextState<TState, AckPrimitive>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /** Register the ack primitive. Adds `ctx.ack()` to all handler contexts in this group. */
    ack(): GroupBuilder<NextState<TState, AckPrimitive>>;
  }
}

/**
 * Prototype patching: adds the runtime `.ack()` implementation to
 * `ServerBuilder`. This is necessary because `declare module` above is purely a
 * compile-time declaration — it does not produce any JavaScript.
 */
ServerBuilder.prototype.ack = function () {
  this._primitives.push(createAck() as unknown as Primitive);
  return this;
};

/**
 * Same runtime patch for `GroupBuilder`. Groups share the same builder pattern
 * as the top-level server builder, so they need their own prototype entry.
 */
GroupBuilder.prototype.ack = function () {
  this._primitives.push(createAck() as unknown as Primitive);
  return this;
};
