/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { CustomReplayPrimitive, CustomReplayOptions, OutgoingWireMessage } from '~/replay/custom.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';
import { handleReplay as createHandleReplay } from '~/replay/custom.ts';
import { ServerBuilder, GroupBuilder } from '~/_builder/server-builder.ts';

export class ReplayCustomBuilder<TParent, _TState extends ScopeStateShape> {
  /** @internal */
  readonly _parent: TParent;
  /** @internal */
  readonly _parentPrimitives: Primitive[];
  /** @internal */
  _options: { onBeforeSend?: any; onAfterSend?: any; onReplay?: any } = {};

  constructor(parent: TParent, parentPrimitives: Primitive[]) {
    this._parent = parent;
    this._parentPrimitives = parentPrimitives;
  }

  onBeforeSend(fn: (message: OutgoingWireMessage<'top'>) => void): this {
    this._options.onBeforeSend = fn;
    return this;
  }

  onAfterSend(fn: (message: OutgoingWireMessage<'top'>) => void | Promise<void>): this {
    this._options.onAfterSend = fn;
    return this;
  }

  onReplay(fn: CustomReplayOptions<'top'>['onReplay']): this {
    this._options.onReplay = fn;
    return this;
  }

  done(): TParent {
    this._parentPrimitives.push(
      createHandleReplay(this._options as CustomReplayOptions<'top'>) as unknown as Primitive,
    );
    return this._parent;
  }

  extract(): CustomReplayPrimitive<'top'> {
    return createHandleReplay(this._options as CustomReplayOptions<'top'>) as CustomReplayPrimitive<'top'>;
  }
}

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    replayCustom(): ReplayCustomBuilder<ServerBuilder<NextState<TState, CustomReplayPrimitive<'top'>>>, TState>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    replayCustom(): ReplayCustomBuilder<GroupBuilder<NextState<TState, CustomReplayPrimitive<'top'>>>, TState>;
  }
}

ServerBuilder.prototype.replayCustom = function (this: ServerBuilder<any>) {
  return new ReplayCustomBuilder(this, this._primitives);
};

GroupBuilder.prototype.replayCustom = function (this: GroupBuilder<any>) {
  return new ReplayCustomBuilder(this, this._primitives);
};
