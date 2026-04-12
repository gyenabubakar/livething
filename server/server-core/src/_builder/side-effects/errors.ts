/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Side-effect import that adds `.errors()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/errors'`
 * Adds method: `.errors(...defs)`
 *
 * Calling `.errors(...defs)` registers named error definitions with the engine.
 * These definitions describe the error events the server can send to clients,
 * and they appear in the generated client types so clients know the shape of
 * every possible error message.
 *
 * Error definitions are created with the `error()` helper from
 * `@wskit/server/errors`. Each definition has an event name and a payload
 * factory:
 *
 * ```ts
 * import { error } from '@wskit/server/errors';
 *
 * const NotFound = error('not-found', (p: { id: string }) => p);
 * const Forbidden = error('forbidden', () => ({}));
 *
 * server('my-handler').errors(NotFound, Forbidden);
 * ```
 *
 * This file uses module augmentation (`declare module`) to teach TypeScript
 * about the new method and prototype patching to add the runtime implementation.
 * The `any` suppression is needed because the variadic generic spread does not
 * reduce cleanly at the prototype level.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { errors as createErrors } from '~/errors/primitive.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type { Primitive } from '~/primitive.ts';

/** Convenience alias — an error definition with an unknown payload type. */
type AnyErrorDef = ErrorDef<string, any>;

/**
 * Module augmentation: adds `.errors()` to the builder interfaces so TypeScript
 * recognises the method after this file is imported.
 *
 * The `const TDefs` constraint preserves the tuple literal type of the spread
 * arguments, which lets the engine generate precise client types for every
 * error definition.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Register one or more named error definitions. The engine forwards these
     * to the client type generator so clients know every possible error event
     * and its payload shape.
     *
     * @param defs One or more error definitions created with `error()`.
     */
    errors<const TDefs extends readonly [AnyErrorDef, ...AnyErrorDef[]]>(
      ...defs: TDefs
    ): ServerBuilder<NextState<TState, ErrorsPrimitive<TDefs>>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Register one or more named error definitions. The engine forwards these
     * to the client type generator so clients know every possible error event
     * and its payload shape.
     *
     * @param defs One or more error definitions created with `error()`.
     */
    errors<const TDefs extends readonly [AnyErrorDef, ...AnyErrorDef[]]>(
      ...defs: TDefs
    ): GroupBuilder<NextState<TState, ErrorsPrimitive<TDefs>>>;
  }
}

/**
 * Runtime implementation of `.errors()` for `ServerBuilder`.
 * `this` is typed as `ServerBuilder<any>` because prototype methods cannot
 * refer to the generic parameter `TState` — TypeScript does not support that.
 */
ServerBuilder.prototype.errors = function (this: ServerBuilder<any>, ...defs: any[]) {
  this._primitives.push(
    createErrors(...(defs as [AnyErrorDef, ...AnyErrorDef[]])) as unknown as Primitive,
  );
  return this;
};

/** Runtime implementation of `.errors()` for `GroupBuilder`. */
GroupBuilder.prototype.errors = function (this: GroupBuilder<any>, ...defs: any[]) {
  this._primitives.push(
    createErrors(...(defs as [AnyErrorDef, ...AnyErrorDef[]])) as unknown as Primitive,
  );
  return this;
};
