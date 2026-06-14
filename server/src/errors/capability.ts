/* oxlint-disable @typescript-eslint/no-explicit-any */
import { capability } from '~/_define/capability.ts';
import { errors as errorsPrimitive } from '~/errors/primitive.ts';
import type { Capability } from '~/_define/capability.ts';
import type { ErrorSlot } from '~/_define/contract.ts';
import type { ErrorDef } from '~/errors/errors.ts';

/** The contract slot `errors([...])` declares — typed server errors the client can catch. */
type ErrorsSlot<TDefs extends readonly ErrorDef<string, any>[]> = { errors: ErrorSlot<TDefs> };

/**
 * Declare the typed errors this server can throw, so they appear in the
 * generated client and can be matched there. List the result in
 * `define({ capabilities: [...] })`. Build each error with the `error(...)`
 * factory.
 *
 * @example
 * ```ts
 * import { define, errors, error, t } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const NotFound = error('not-found', v.object({ id: v.string() }));
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [errors([NotFound])],
 * });
 *
 * // throw NotFound({ id: 'missing' });
 * ```
 */
export function errors<
  const TDefs extends readonly [ErrorDef<string, any>, ...ErrorDef<string, any>[]],
>(defs: TDefs): Capability<ErrorsSlot<TDefs>> {
  return capability<ErrorsSlot<TDefs>>([errorsPrimitive(...defs)]);
}
