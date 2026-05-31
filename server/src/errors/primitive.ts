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
 * Internal primitive factory. The user-facing way to register typed errors is
 * the contract's `errors: [...]` array; the implementer compiles that list
 * into this primitive so the engine can recognise each declared error code at
 * runtime and `InferClient` can surface them to the client SDK.
 *
 * @param defs One or more error definitions. At least one is required.
 *
 * @example
 * ```ts
 * import { contract, error, implement, incoming } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const NotFound = error('not-found', v.object({ id: v.string() }));
 *
 * const c = contract('users', { env: t<Env>(),
 *   errors: [NotFound],
 *   definitions: [incoming('get-user', GetUser)],
 * });
 *
 * implement(c).on('get-user', async (ctx, payload) => {
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
