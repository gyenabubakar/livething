import type { SequencePrimitive, SequenceOptions } from '~/sequence/sequence.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import { sequence as createSequence } from '~/sequence/sequence.ts';
import type { Primitive } from '~/primitive.ts';
import { ServerBuilder, GroupBuilder } from '~/_builder/server-builder.ts';

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    sequence(options?: SequenceOptions): ServerBuilder<NextState<TState, SequencePrimitive>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    sequence(options?: SequenceOptions): GroupBuilder<NextState<TState, SequencePrimitive>>;
  }
}

ServerBuilder.prototype.sequence = function (options?: SequenceOptions) {
  this._primitives.push(createSequence(options) as unknown as Primitive);
  return this;
};

GroupBuilder.prototype.sequence = function (options?: SequenceOptions) {
  this._primitives.push(createSequence(options) as unknown as Primitive);
  return this;
};
