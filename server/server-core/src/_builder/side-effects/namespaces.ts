/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EventContract } from '~/event.ts';
import type { NamespacePrimitive } from '~/namespace/namespace.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
import type {
  HandlerCtxFromState,
  NextState,
  ScopeState,
  ScopeStateShape,
} from '~/_types/scope-state.ts';
import { namespace as createNamespace } from '~/namespace/namespace.ts';
import { incoming as createIncoming } from '~/incoming/incoming.ts';
import { outgoing as createOutgoing } from '~/outgoing/outgoing.ts';
import { ServerBuilder, GroupBuilder } from '~/_builder/server-builder.ts';

type NamespaceState<TParentState extends ScopeStateShape> = ScopeState<
  'namespace',
  TParentState['outgoing'],
  TParentState['hasAck'],
  TParentState['hasReplay']
>;

type StateAfterOutgoing<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, OutgoingPrimitive<TEvent, TPayload>>;

type StateAfterIncoming<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, IncomingPrimitive<TEvent, TPayload, any>>;

export class NamespaceBuilder<TParentState extends ScopeStateShape, TState extends ScopeStateShape = NamespaceState<TParentState>> {
  /** @internal */
  readonly _parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>;
  /** @internal */
  readonly _parentPrimitives: Primitive[];
  /** @internal */
  readonly _primitives: Primitive[] = [];
  /** @internal */
  readonly _name: string;

  constructor(
    parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>,
    parentPrimitives: Primitive[],
    name: string,
  ) {
    this._parentBuilder = parentBuilder;
    this._parentPrimitives = parentPrimitives;
    this._name = name;
  }

  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): NamespaceBuilder<TParentState, StateAfterOutgoing<TState, TEvent, TPayload>> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): NamespaceBuilder<TParentState, StateAfterIncoming<TState, TEvent, TPayload>> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  done(): ServerBuilder<TParentState> {
    const nsPrimitive = (createNamespace as any)(
      this._name,
      ...this._primitives,
    ) as Primitive;
    this._parentPrimitives.push(nsPrimitive);
    return this._parentBuilder as any;
  }

  extract(): NamespacePrimitive {
    return (createNamespace as any)(
      this._name,
      ...this._primitives,
    ) as NamespacePrimitive;
  }
}

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    namespace(name: string): NamespaceBuilder<TState>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    namespace(name: string): NamespaceBuilder<TState>;
  }
}

ServerBuilder.prototype.namespace = function (this: ServerBuilder<any>, name: string) {
  return new NamespaceBuilder(this, this._primitives, name);
};

GroupBuilder.prototype.namespace = function (this: GroupBuilder<any>, name: string) {
  return new NamespaceBuilder(this as any, this._primitives, name);
};
