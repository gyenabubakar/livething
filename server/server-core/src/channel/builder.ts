/* oxlint-disable @typescript-eslint/no-explicit-any */

import { channel as createChannel } from '~/channel/channel.ts';
import {
  onBeforeSubscribe as createOnBeforeSubscribe,
  onSubscribe as createOnSubscribe,
  onUnsubscribe as createOnUnsubscribe,
} from '~/channel/lifecycle.ts';
import { incoming as createIncoming } from '~/incoming/incoming.ts';
import { outgoing as createOutgoing } from '~/outgoing/outgoing.ts';
import type { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import type { ChannelBuilderFull, FeatureApplicator } from '~/_types/feature-methods.ts';
import type {
  HandlerCtxFromState,
  NextState,
  ScopeState,
  ScopeStateShape,
} from '~/_types/scope-state.ts';
import type { ChannelPattern, ScopeDeclaration } from '~/channel/channel.ts';
import type { EventContract } from '~/event.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * The running type state for one `channel(...)` scope.
 *
 * Inherits the outgoing map, `ack`, `replay`, and `meta` from the parent
 * server scope — so events, ack, and replay declared at the top level are
 * still visible inside the channel's handler ctx. The contract, however,
 * starts empty: a channel's own incoming/outgoing/request/stream
 * declarations are tracked separately.
 */
type ChannelState<TParentState extends ScopeStateShape> = ScopeState<
  'channel',
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

type StateAfterOutgoing<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, OutgoingPrimitive<TEvent, TPayload>>;

/**
 * Extracts a narrow channel name from a channel pattern.
 *
 * For a static name like `'lobby'` the result is the literal `'lobby'`.
 * For a dynamic pattern such as `scope('room/:id')`, channel names cannot be
 * enumerated at compile time, so this widens to `string & {}` — any string
 * is accepted but editor autocomplete still prefers known channel names.
 */
type ChannelNameFromPattern<TPattern> = TPattern extends ScopeDeclaration
  ? string & {}
  : TPattern extends string
    ? TPattern
    : never;

/**
 * The exported contract shape for a single channel scope.
 *
 * This is what the inferred client sees for this channel: its incoming,
 * outgoing, requests, and streams. It intentionally omits infrastructure
 * bits (ack, replay, channel names) because those live on the top-level
 * contract, not per-channel.
 */
type ChannelContract<TChannelState extends ScopeStateShape> = {
  incoming: TChannelState['contract']['incoming'];
  outgoing: TChannelState['contract']['outgoing'];
  requests: TChannelState['contract']['requests'];
  streams: TChannelState['contract']['streams'];
};

type StateAfterIncoming<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, IncomingPrimitive<TEvent, TPayload, any>>;

/**
 * Fluent builder for defining a pub/sub channel. Channels let connections
 * subscribe, unsubscribe, and exchange messages within a named group. Use
 * `channel()` on a server builder to start one.
 */
export class ChannelBuilder<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape = ChannelState<TParentState>,
  TPattern extends ChannelPattern = ChannelPattern,
  TFeatures = {},
> {
  /** @internal */
  readonly _parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>;
  /** @internal */
  readonly _parentPrimitives: Primitive[];
  /** @internal */
  readonly _primitives: Primitive[] = [];
  /** @internal */
  readonly _pattern: TPattern;
  /** @internal */
  readonly _featureApplicators: FeatureApplicator[] = [];

  constructor(
    parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>,
    parentPrimitives: Primitive[],
    pattern: TPattern,
  ) {
    this._parentBuilder = parentBuilder;
    this._parentPrimitives = parentPrimitives;
    this._pattern = pattern;
  }

  /** Register an event this channel can send to its members. */
  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): ChannelBuilderFull<
    TParentState,
    StateAfterOutgoing<TState, TEvent, TPayload>,
    TPattern,
    TFeatures
  > {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  /** Register an event the channel can receive from subscribed clients. */
  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): ChannelBuilderFull<
    TParentState,
    StateAfterIncoming<TState, TEvent, TPayload>,
    TPattern,
    TFeatures
  > {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  /** Run a check before a client joins — throw to reject the subscription. */
  onBeforeSubscribe(
    handler: (ctx: HandlerCtxFromState<TState>, data?: unknown) => void | Promise<void>,
  ): this {
    this._primitives.push(createOnBeforeSubscribe(handler as any) as unknown as Primitive);
    return this;
  }

  /** Run code after a client successfully subscribes. */
  onSubscribe(handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>): this {
    this._primitives.push(createOnSubscribe(handler as any) as unknown as Primitive);
    return this;
  }

  /** Run code after a client leaves the channel. */
  onUnsubscribe(handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>): this {
    this._primitives.push(createOnUnsubscribe(handler as any) as unknown as Primitive);
    return this;
  }

  /** @internal Seal the channel and push it onto the parent's primitive list. */
  _seal(): void {
    const channelPrimitive = (createChannel as any)(
      this._pattern,
      ...this._primitives,
    ) as Primitive;
    this._parentPrimitives.push(channelPrimitive);
  }
}

export type { ChannelState, ChannelNameFromPattern, ChannelContract };
