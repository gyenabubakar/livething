/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Side-effect import that adds `.namespace()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/namespaces'`
 * Adds method: `.namespace(name)`
 *
 * Namespaces group events and handlers under a named prefix. All events
 * declared inside a namespace are prefixed at the wire level so clients can
 * route them independently — for example a `chat` namespace might carry
 * `chat/message` and `chat/typing` events while a `presence` namespace carries
 * `presence/join` and `presence/leave`.
 *
 * Unlike channels, namespaces are static — a connection is always in a
 * namespace, there is no subscribe/unsubscribe. They also do not support replay
 * or ack at the namespace level.
 *
 * Calling `.namespace(name)` returns a `NamespaceBuilder` with:
 *   - `.outgoing(contract)` — declare a server→client event in this namespace
 *   - `.incoming(contract, handler)` — handle a client→server event
 *   - `.extract()` — detach as a reusable `NamespacePrimitive`
 *
 * This file also exports `NamespaceBuilder` for use in `.extract()` workflows
 * and uses module augmentation + prototype patching to wire `.namespace()` into
 * the existing builders.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { incoming as createIncoming } from '~/incoming/incoming.ts';
import { namespace as createNamespace } from '~/namespace/namespace.ts';
import { outgoing as createOutgoing } from '~/outgoing/outgoing.ts';
import type {
  HandlerCtxFromState,
  NextState,
  ScopeState,
  ScopeStateShape,
} from '~/_types/scope-state.ts';
import type { EventContract } from '~/event.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { NamespaceChild, NamespacePrimitive } from '~/namespace/namespace.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * The initial type-level state for a namespace scope. A namespace inherits the
 * parent's outgoing events but does not carry ack or replay flags (namespaces
 * do not support those features).
 */
type NamespaceState<TParentState extends ScopeStateShape> = ScopeState<
  'namespace',
  TParentState['outgoing'],
  TParentState['hasAck'],
  TParentState['hasReplay'],
  { incoming: {}; outgoing: {}; requests: {}; streams: {}; channels: {}; namespaces: {} },
  readonly [],
  TParentState['meta'],
  TParentState['channelNames'],
  TParentState['scheduledTaskIds'],
  TParentState['env']
>;

/**
 * Extract the namespace's inner contract from the namespace scope's state.
 */
type NamespaceContract<TNamespaceState extends ScopeStateShape> = {
  incoming: TNamespaceState['contract']['incoming'];
  outgoing: TNamespaceState['contract']['outgoing'];
  requests: TNamespaceState['contract']['requests'];
  streams: TNamespaceState['contract']['streams'];
};

/** Helper: the state produced after registering an outgoing event on the namespace. */
type StateAfterOutgoing<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, OutgoingPrimitive<TEvent, TPayload>>;

/** Helper: the state produced after registering an incoming handler on the namespace. */
type StateAfterIncoming<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, IncomingPrimitive<TEvent, TPayload, any>>;

/**
 * A sub-builder returned by `.namespace()`. Holds the namespace's primitives
 * until sealed (via the callback form), at which point they are packaged into a
 * `NamespacePrimitive` and pushed onto the parent builder's primitive list.
 *
 * `TParentState` tracks the parent builder's state so the callback form returns
 * to the correctly typed parent. `TState` tracks state changes within the
 * namespace scope.
 */
export class NamespaceBuilder<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape = NamespaceState<TParentState>,
  TName extends string = string,
> {
  /** @internal Reference to the parent builder, so `_seal()` can return to it. */
  readonly _parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>;
  /** @internal The parent builder's primitive array, so `_seal()` can push into it. */
  readonly _parentPrimitives: Primitive[];
  /** @internal Primitives collected inside this namespace scope. */
  readonly _primitives: Primitive[] = [];
  /** @internal The namespace name (used as the event prefix). */
  readonly _name: TName;

  constructor(
    parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>,
    parentPrimitives: Primitive[],
    name: TName,
  ) {
    this._parentBuilder = parentBuilder;
    this._parentPrimitives = parentPrimitives;
    this._name = name;
  }

  /**
   * Declare a server→client event in this namespace. The event is prefixed with
   * the namespace name at the wire level (e.g. `chat/message`).
   */
  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): NamespaceBuilder<TParentState, StateAfterOutgoing<TState, TEvent, TPayload>, TName> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  /**
   * Handle a client→server event in this namespace. The `handler` receives a
   * context scoped to this namespace and the validated payload.
   */
  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): NamespaceBuilder<TParentState, StateAfterIncoming<TState, TEvent, TPayload>, TName> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  /** @internal Seal the namespace and push it onto the parent's primitive list. */
  _seal(): void {
    const nsPrimitive = (createNamespace as any)(this._name, ...this._primitives) as Primitive;
    this._parentPrimitives.push(nsPrimitive);
  }
}

/**
 * Module augmentation: adds `.namespace()` to the builder interfaces so
 * TypeScript recognises the method after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Define a namespace using a callback. Returns a `NamespacePrimitive` that
     * can be passed to `.use()` or exported for multi-file composition.
     */
    namespace<TName extends string, TNamespaceState extends ScopeStateShape>(
      name: TName,
      callback: (
        builder: NamespaceBuilder<TState, NamespaceState<TState>, TName>,
      ) => NamespaceBuilder<TState, TNamespaceState, TName>,
    ): NamespacePrimitive<
      TName,
      readonly NamespaceChild[],
      TName,
      NamespaceContract<TNamespaceState>
    >;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Define a namespace using a callback.
     */
    namespace<TName extends string, TNamespaceState extends ScopeStateShape>(
      name: TName,
      callback: (
        builder: NamespaceBuilder<TState, NamespaceState<TState>, TName>,
      ) => NamespaceBuilder<TState, TNamespaceState, TName>,
    ): NamespacePrimitive<
      TName,
      readonly NamespaceChild[],
      TName,
      NamespaceContract<TNamespaceState>
    >;
  }
}

/** Runtime implementation of `.namespace()` for `ServerBuilder`. */
(ServerBuilder.prototype as any).namespace = function (
  this: ServerBuilder<any>,
  name: string,
  callback: (builder: NamespaceBuilder<any>) => NamespaceBuilder<any>,
) {
  const builder = new NamespaceBuilder(this, [], name);
  callback(builder);
  return (createNamespace as any)(name, ...builder._primitives);
};

/** Runtime implementation of `.namespace()` for `GroupBuilder`. */
(GroupBuilder.prototype as any).namespace = function (
  this: GroupBuilder<any>,
  name: string,
  callback: (builder: NamespaceBuilder<any>) => NamespaceBuilder<any>,
) {
  const builder = new NamespaceBuilder(this as any, [], name);
  callback(builder);
  return (createNamespace as any)(name, ...builder._primitives);
};

/** @internal Side-effect registration marker. */
export const __sideEffect_namespaces = true;
