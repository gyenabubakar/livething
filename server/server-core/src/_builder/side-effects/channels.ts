/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Side-effect import that adds `.channel()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/channels'`
 * Adds method: `.channel(pattern)`
 *
 * Channels are named pub/sub scopes within a WebSocket connection. A single
 * connection can subscribe to many channels simultaneously, each with its own
 * outgoing events, incoming handlers, replay, and lifecycle hooks.
 *
 * Calling `.channel(pattern)` returns a `ChannelBuilder`, which has its own
 * fluent API:
 *   - `.outgoing(contract)` — declare a server→client event for this channel
 *   - `.incoming(contract, handler)` — handle a client→server event
 *   - `.onBeforeSubscribe(handler)` — called before a client subscribes
 *   - `.onSubscribe(handler)` — called when a client subscribes
 *   - `.onUnsubscribe(handler)` — called when a client unsubscribes
 *   - `.done()` — finish the channel and return to the parent builder
 *   - `.extract()` — detach as a reusable `ChannelPrimitive`
 *
 * The `pattern` can be a plain string (exact match) or a `ScopeDeclaration`
 * created with `scope(key, regex)` for dynamic channel names that capture
 * a parameter from the subscription path.
 *
 * This file also exports `ChannelBuilder` for use in `.extract()` workflows and
 * uses module augmentation + prototype patching to wire `.channel()` into the
 * existing builders.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { channel as createChannel } from '~/channel/channel.ts';
import {
  onBeforeSubscribe as createOnBeforeSubscribe,
  onSubscribe as createOnSubscribe,
  onUnsubscribe as createOnUnsubscribe,
} from '~/channel/lifecycle.ts';
import { incoming as createIncoming } from '~/incoming/incoming.ts';
import { outgoing as createOutgoing } from '~/outgoing/outgoing.ts';
import type {
  HandlerCtxFromState,
  NextState,
  ScopeState,
  ScopeStateShape,
} from '~/_types/scope-state.ts';
import type { ChannelPattern, ChannelPrimitive } from '~/channel/channel.ts';
import type { EventContract } from '~/event.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * The initial type-level state for a channel scope. A channel inherits the
 * parent's outgoing events, ack flag, and replay flag, but lives in its own
 * `'channel'` scope kind so context types are scoped correctly.
 */
type ChannelState<TParentState extends ScopeStateShape> = ScopeState<
  'channel',
  TParentState['outgoing'],
  TParentState['hasAck'],
  TParentState['hasReplay']
>;

/** Helper: the state produced after registering an outgoing event on the channel. */
type StateAfterOutgoing<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, OutgoingPrimitive<TEvent, TPayload>>;

/** Helper: the state produced after registering an incoming handler on the channel. */
type StateAfterIncoming<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, IncomingPrimitive<TEvent, TPayload, any>>;

/**
 * A sub-builder returned by `.channel()`. Holds the channel's primitives until
 * `.done()` is called, at which point they are packaged into a `ChannelPrimitive`
 * and pushed onto the parent builder's primitive list.
 *
 * `TParentState` tracks the parent builder's state so that `.done()` can return
 * to the correctly typed parent. `TState` tracks state changes made inside the
 * channel scope (e.g. which outgoing events have been declared).
 */
export class ChannelBuilder<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape = ChannelState<TParentState>,
> {
  /** @internal Reference to the parent builder, so `.done()` can return to it. */
  readonly _parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>;
  /** @internal The parent builder's primitive array, so `.done()` can push into it. */
  readonly _parentPrimitives: Primitive[];
  /** @internal Primitives collected inside this channel scope. */
  readonly _primitives: Primitive[] = [];
  /** @internal The channel pattern (string or ScopeDeclaration). */
  readonly _pattern: ChannelPattern;

  constructor(
    parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>,
    parentPrimitives: Primitive[],
    pattern: ChannelPattern,
  ) {
    this._parentBuilder = parentBuilder;
    this._parentPrimitives = parentPrimitives;
    this._pattern = pattern;
  }

  /**
   * Declare a server→client event for this channel.
   * The event only appears in the type-generated client when the connection is
   * subscribed to this channel.
   */
  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): ChannelBuilder<TParentState, StateAfterOutgoing<TState, TEvent, TPayload>> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  /**
   * Handle a client→server event sent on this channel. The `handler` receives
   * a context scoped to this channel (including `ctx.channel`) and the validated
   * payload.
   */
  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): ChannelBuilder<TParentState, StateAfterIncoming<TState, TEvent, TPayload>> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  /**
   * Run `handler` before a client subscribes to this channel.
   * Throw to reject the subscription. Receives optional subscribe data
   * (e.g. a token the client passed when subscribing).
   */
  onBeforeSubscribe(
    handler: (ctx: HandlerCtxFromState<TState>, data?: unknown) => void | Promise<void>,
  ): this {
    this._primitives.push(createOnBeforeSubscribe(handler as any) as unknown as Primitive);
    return this;
  }

  /**
   * Run `handler` after a client has successfully subscribed to this channel.
   * Use this to send initial state to the newly subscribed client.
   */
  onSubscribe(handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>): this {
    this._primitives.push(createOnSubscribe(handler as any) as unknown as Primitive);
    return this;
  }

  /**
   * Run `handler` when a client unsubscribes from this channel or disconnects
   * while subscribed.
   */
  onUnsubscribe(handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>): this {
    this._primitives.push(createOnUnsubscribe(handler as any) as unknown as Primitive);
    return this;
  }

  /**
   * Finish building the channel. Packages all collected primitives into a
   * `ChannelPrimitive` and pushes it onto the parent builder, then returns the
   * parent builder so the fluent chain can continue.
   */
  done(): ServerBuilder<TParentState> {
    const channelPrimitive = (createChannel as any)(
      this._pattern,
      ...this._primitives,
    ) as Primitive;
    this._parentPrimitives.push(channelPrimitive);
    return this._parentBuilder as any;
  }

  /**
   * Package all collected primitives into a standalone `ChannelPrimitive`
   * without pushing it onto the parent builder. Use this to define a channel
   * in one file and register it elsewhere with `.use()`.
   */
  extract(): ChannelPrimitive {
    return (createChannel as any)(this._pattern, ...this._primitives) as ChannelPrimitive;
  }
}

/**
 * Module augmentation: adds `.channel()` to the builder interfaces so
 * TypeScript recognises the method after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Open a channel sub-builder for `pattern`. Call `.done()` to seal it and
     * return to this builder, or `.extract()` to detach it as a primitive.
     *
     * @param pattern A string for exact channel names, or a `ScopeDeclaration`
     *   (`scope(key, regex)`) for dynamic names that capture a parameter.
     */
    channel(pattern: ChannelPattern): ChannelBuilder<TState>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Open a channel sub-builder for `pattern`. Call `.done()` to seal it and
     * return to this builder, or `.extract()` to detach it as a primitive.
     */
    channel(pattern: ChannelPattern): ChannelBuilder<TState>;
  }
}

/** Runtime implementation of `.channel()` for `ServerBuilder`. */
ServerBuilder.prototype.channel = function (this: ServerBuilder<any>, pattern: ChannelPattern) {
  return new ChannelBuilder(this, this._primitives, pattern);
};

/** Runtime implementation of `.channel()` for `GroupBuilder`. */
GroupBuilder.prototype.channel = function (this: GroupBuilder<any>, pattern: ChannelPattern) {
  return new ChannelBuilder(this as any, this._primitives, pattern);
};
