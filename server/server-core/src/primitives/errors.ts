/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitives/define.ts';
import type { ErrorDef } from '~/errors.ts';
import type { Primitive } from '~/primitives/define.ts';

type AnyErrorDef = ErrorDef<string, any>;

/**
 * The primitive instance returned by `errors()`. Carries the tuple of
 * registered error definitions for `InferClientType` and later runtime
 * enforcement.
 */
export interface ErrorsPrimitive<
  TDefs extends readonly AnyErrorDef[] = readonly AnyErrorDef[],
> extends Primitive<'errors'> {
  readonly defs: TDefs;
}

const ERRORS_KEY = Symbol('errors');

const _errors = definePrimitive<
  'errors',
  [firstDef: AnyErrorDef, ...restDefs: AnyErrorDef[]],
  { defs: readonly AnyErrorDef[] }
>({
  tag: 'errors' as const,
  key: ERRORS_KEY,
  kind: 'contract' as const,
  create(firstDef: AnyErrorDef, ...restDefs: AnyErrorDef[]) {
    return { defs: [firstDef, ...restDefs] };
  },
});

/**
 * Register the application's typed errors.
 *
 * `errors()` is a singleton contract primitive. It does not change runtime
 * behavior by itself here — it carries the declared error definitions so the
 * engine and client contract can read them later.
 *
 * ```ts
 * errors(Forbidden, ChannelNotFound, QuotaExceeded)
 * ```
 */
export function errors<const TDefs extends readonly [AnyErrorDef, ...AnyErrorDef[]]>(
  ...defs: TDefs
): ErrorsPrimitive<TDefs>;
export function errors(firstDef: AnyErrorDef, ...restDefs: AnyErrorDef[]): ErrorsPrimitive {
  return _errors(firstDef, ...restDefs) as unknown as ErrorsPrimitive;
}

/** Dependency ref — use in `dependencies: [errors]` to assert it's registered. */
errors.__key = ERRORS_KEY;
