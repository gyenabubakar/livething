/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { collectUnique } from '~/_engine/compile/utils.ts';
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
 *   capabilities: [errors([NotFound])],
 * });
 *
 * // throw NotFound({ id: 'missing' });
 * ```
 */
export const errors = withCapabilityKind(function errors<
  const TDefs extends readonly [ErrorDef<string, any>, ...ErrorDef<string, any>[]],
>(defs: TDefs): Capability<ErrorsSlot<TDefs>, never, never, typeof CAPABILITY_KIND.errors> {
  collectUnique(defs, (def) => def.code, { kind: 'error code', context: 'errors([...])' });
  return stampKind(
    capability<ErrorsSlot<TDefs>, never, never, typeof CAPABILITY_KIND.errors>([
      errorsPrimitive(...defs),
    ]),
    CAPABILITY_KIND.errors,
  );
}, CAPABILITY_KIND.errors);
