/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitive.ts';
import type { ErrorDef } from '~/errors.ts';
import type { Primitive } from '~/primitive.ts';

type AnyErrorDef = ErrorDef<string, any>;

/**
 * The primitive instance returned by `errors()`.
 *
 * It holds the list of application errors your server may throw, so the
 * client contract can know about them too.
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
  setup(engine, data) {
    engine.registerErrorDefinitions(data.defs);
  },
});

/**
 * Register the application's typed errors.
 *
 * This tells wskit which named application errors belong to this server.
 * It does not add methods to `ctx`, but it lets the engine and
 * `InferClient` understand the typed error surface.
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
