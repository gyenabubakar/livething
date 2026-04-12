/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ErrorDef } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import { errors as createErrors } from '~/errors/primitive.ts';
import type { Primitive } from '~/primitive.ts';
import { ServerBuilder, GroupBuilder } from '~/_builder/server-builder.ts';

type AnyErrorDef = ErrorDef<string, any>;

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    errors<const TDefs extends readonly [AnyErrorDef, ...AnyErrorDef[]]>(
      ...defs: TDefs
    ): ServerBuilder<NextState<TState, ErrorsPrimitive<TDefs>>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    errors<const TDefs extends readonly [AnyErrorDef, ...AnyErrorDef[]]>(
      ...defs: TDefs
    ): GroupBuilder<NextState<TState, ErrorsPrimitive<TDefs>>>;
  }
}

ServerBuilder.prototype.errors = function (this: ServerBuilder<any>, ...defs: any[]) {
  this._primitives.push(createErrors(...(defs as [AnyErrorDef, ...AnyErrorDef[]])) as unknown as Primitive);
  return this;
};

GroupBuilder.prototype.errors = function (this: GroupBuilder<any>, ...defs: any[]) {
  this._primitives.push(createErrors(...(defs as [AnyErrorDef, ...AnyErrorDef[]])) as unknown as Primitive);
  return this;
};
