import type { AckPrimitive } from '~/ack/ack.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import { ack as createAck } from '~/ack/ack.ts';
import type { Primitive } from '~/primitive.ts';
import { ServerBuilder, GroupBuilder } from '~/_builder/server-builder.ts';

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    ack(): ServerBuilder<NextState<TState, AckPrimitive>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    ack(): GroupBuilder<NextState<TState, AckPrimitive>>;
  }
}

ServerBuilder.prototype.ack = function () {
  this._primitives.push(createAck() as unknown as Primitive);
  return this;
};

GroupBuilder.prototype.ack = function () {
  this._primitives.push(createAck() as unknown as Primitive);
  return this;
};
