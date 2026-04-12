import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { hibernation as createHibernation } from '~/hibernation/hibernation.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { HibernationPrimitive } from '~/hibernation/hibernation.ts';
import type { Primitive } from '~/primitive.ts';

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    hibernation(enabled?: boolean): ServerBuilder<NextState<TState, HibernationPrimitive>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    hibernation(enabled?: boolean): GroupBuilder<NextState<TState, HibernationPrimitive>>;
  }
}

ServerBuilder.prototype.hibernation = function (enabled?: boolean) {
  this._primitives.push(createHibernation(enabled) as unknown as Primitive);
  return this;
};

GroupBuilder.prototype.hibernation = function (enabled?: boolean) {
  this._primitives.push(createHibernation(enabled) as unknown as Primitive);
  return this;
};
