/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import type { ErrorDef } from './errors.ts';

/** Convenience alias used inside this file. */
type AnyErrorDef = ErrorDef<string, any>;

/**
 * The primitive type produced by `errors()`. Carries the full tuple of error
 * definitions so the type generator can include each error event in the
 * client's type output.
 *
 * `TDefs` is kept as a tuple (not a plain array) so TypeScript can distinguish
 * each definition by position and produce exact per-error types.
 */
export interface ErrorsPrimitive<
  TDefs extends readonly AnyErrorDef[] = readonly AnyErrorDef[],
> extends Primitive<'errors'> {
  /** The error definitions registered with this primitive. */
  readonly defs: TDefs;
}

/** Unique symbol used to enforce one errors registration per handler scope. */
const ERRORS_KEY = Symbol('errors');

/**
 * Creates an errors primitive. When registered, this primitive tells the engine
 * which named error events this handler can send to clients. At runtime it calls
 * `engine.registerErrorDefinitions(defs)` to make the error factories available
 * in the execution context. At build time the `TDefs` tuple drives the generated
 * client types.
 *
 * Error definitions are created with the `error()` helper from
 * `@wskit/server/errors`. Each definition carries an event name and a payload
 * factory function.
 *
 * In practice you rarely call `errors()` directly. Use it through the builder:
 * `server('name').errors(NotFound, Forbidden)` — that method calls this factory
 * internally.
 *
 * @param defs One or more error definitions. At least one is required.
 *
 * @example
 * ```ts
 * import { error } from '@wskit/server/errors';
 *
 * const NotFound = error('not-found', (p: { id: string }) => p);
 *
 * server('chat').errors(NotFound).incoming(getUser, (ctx, payload) => {
 *   const user = await db.find(payload.id);
 *   if (!user) throw NotFound({ id: payload.id });
 * });
 * ```
 */
export function errors<const TDefs extends readonly [AnyErrorDef, ...AnyErrorDef[]]>(
  ...defs: TDefs
): ErrorsPrimitive<TDefs> {
  return {
    __wskit: 'errors',
    __kind: 'contract',
    __identity: [ERRORS_KEY],
    __dependencies: [],
    __requires: {},
    defs,
    __setup(engine) {
      engine.registerErrorDefinitions(defs);
    },
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
errors.__key = ERRORS_KEY;
