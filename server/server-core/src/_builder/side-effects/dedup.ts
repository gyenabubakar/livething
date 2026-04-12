import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { dedup as createDedup } from '~/dedup/dedup.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { DedupPrimitive } from '~/dedup/dedup.ts';
import type { Primitive } from '~/primitive.ts';

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    dedup(): ServerBuilder<NextState<TState, DedupPrimitive>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    dedup(): GroupBuilder<NextState<TState, DedupPrimitive>>;
  }
}

ServerBuilder.prototype.dedup = function () {
  this._primitives.push(createDedup() as unknown as Primitive);
  return this;
};

GroupBuilder.prototype.dedup = function () {
  this._primitives.push(createDedup() as unknown as Primitive);
  return this;
};
