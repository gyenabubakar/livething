/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import type { ErrorDef } from './errors.ts';

type AnyErrorDef = ErrorDef<string, any>;

export interface ErrorsPrimitive<
  TDefs extends readonly AnyErrorDef[] = readonly AnyErrorDef[],
> extends Primitive<'errors'> {
  readonly defs: TDefs;
}

const ERRORS_KEY = Symbol('errors');

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

errors.__key = ERRORS_KEY;
