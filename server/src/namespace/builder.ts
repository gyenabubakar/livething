/* oxlint-disable @typescript-eslint/no-explicit-any */
import { incoming as createIncoming } from '~/incoming/incoming.ts';
import { namespace as createNamespace } from '~/namespace/namespace.ts';
import { outgoing as createOutgoing } from '~/outgoing/outgoing.ts';
import type { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import type { FeatureApplicator, NamespaceBuilderFull } from '~/_types/feature-methods.ts';
import type { HandlerCtxFromState, NextState, ScopeStateShape } from '~/_types/scope-state';
import type { EventContract } from '~/event.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';

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

/**
 * Fluent builder for defining a namespace. Namespaces isolate a set of events
 * under a name so that different parts of your app (e.g. 'chat', 'ai') can
 * have their own incoming/outgoing handlers without colliding.
 */
export class NamespaceBuilder<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape = ScopeStateShape,
  TName extends string = string,
  TFeatures = {},
> {
  readonly _parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>;
  readonly _parentPrimitives: Primitive[];
  readonly _primitives: Primitive[] = [];
  readonly _name: TName;
  readonly _featureApplicators: FeatureApplicator[] = [];

  constructor(
    parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>,
    parentPrimitives: Primitive[],
    name: TName,
  ) {
    this._parentBuilder = parentBuilder;
    this._parentPrimitives = parentPrimitives;
    this._name = name;
  }

  /** Register an event this namespace can send to clients. */
  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): NamespaceBuilderFull<
    TParentState,
    StateAfterOutgoing<TState, TEvent, TPayload>,
    TName,
    TFeatures
  > {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  /** Register an event this namespace can receive from clients. */
  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): NamespaceBuilderFull<
    TParentState,
    StateAfterIncoming<TState, TEvent, TPayload>,
    TName,
    TFeatures
  > {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  _seal(): void {
    const nsPrimitive = (createNamespace as any)(this._name, ...this._primitives) as Primitive;
    this._parentPrimitives.push(nsPrimitive);
  }
}
