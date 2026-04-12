/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type { ReplayOptions, ReplayRetention, ReplaySnapshotValue, ReplayType } from '~/replay/types.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';
import { replay as createReplay } from '~/replay/replay.ts';
import { ServerBuilder, GroupBuilder } from '~/_builder/server-builder.ts';

export class ReplayBuilder<TParent, _TState extends ScopeStateShape> {
  /** @internal */
  readonly _parent: TParent;
  /** @internal */
  readonly _parentPrimitives: Primitive[];
  /** @internal */
  _options: ReplayOptions = {};

  constructor(parent: TParent, parentPrimitives: Primitive[], type?: ReplayType) {
    this._parent = parent;
    this._parentPrimitives = parentPrimitives;
    if (type) this._options = { ...this._options, type };
  }

  exclude(...events: string[]): this {
    this._options = { ...this._options, exclude: events };
    return this;
  }

  retention(retention: ReplayRetention): this {
    this._options = { ...this._options, retention };
    return this;
  }

  durability(durability: 'strict' | 'best-effort'): this {
    this._options = { ...this._options, durability };
    return this;
  }

  snapshotKey(fn: (event: string, payload: Record<string, unknown>) => string): this {
    this._options = { ...this._options, snapshotKey: fn };
    return this;
  }

  reduce(fn: (previous: ReplaySnapshotValue | null, next: ReplaySnapshotValue) => ReplaySnapshotValue | null): this {
    this._options = { ...this._options, reduce: fn };
    return this;
  }

  done(): TParent {
    this._parentPrimitives.push(createReplay(this._options) as unknown as Primitive);
    return this._parent;
  }

  extract(): ReplayPrimitive {
    return createReplay(this._options) as ReplayPrimitive;
  }
}

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    replay(type?: ReplayType): ReplayBuilder<ServerBuilder<NextState<TState, ReplayPrimitive>>, TState>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    replay(type?: ReplayType): ReplayBuilder<GroupBuilder<NextState<TState, ReplayPrimitive>>, TState>;
  }
}

ServerBuilder.prototype.replay = function (this: ServerBuilder<any>, type?: ReplayType) {
  return new ReplayBuilder(this, this._primitives, type);
};

GroupBuilder.prototype.replay = function (this: GroupBuilder<any>, type?: ReplayType) {
  return new ReplayBuilder(this, this._primitives, type);
};
