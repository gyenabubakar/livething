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

type ChannelNameFromPattern<TPattern> = TPattern extends ScopeDeclaration
  ? string & {}
  : TPattern extends string
    ? TPattern
    : never;

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

export class ChannelBuilder<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape = ChannelState<TParentState>,
  TPattern extends ChannelPattern = ChannelPattern,
> {
  /** @internal */
  readonly _parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>;
  /** @internal */
  readonly _parentPrimitives: Primitive[];
  /** @internal */
  readonly _primitives: Primitive[] = [];
  /** @internal */
  readonly _pattern: TPattern;

  constructor(
    parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>,
    parentPrimitives: Primitive[],
    pattern: TPattern,
  ) {
    this._parentBuilder = parentBuilder;
    this._parentPrimitives = parentPrimitives;
    this._pattern = pattern;
  }

  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): ChannelBuilder<TParentState, StateAfterOutgoing<TState, TEvent, TPayload>, TPattern> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): ChannelBuilder<TParentState, StateAfterIncoming<TState, TEvent, TPayload>, TPattern> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  onBeforeSubscribe(
    handler: (ctx: HandlerCtxFromState<TState>, data?: unknown) => void | Promise<void>,
  ): this {
    this._primitives.push(createOnBeforeSubscribe(handler as any) as unknown as Primitive);
    return this;
  }

  onSubscribe(handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>): this {
    this._primitives.push(createOnSubscribe(handler as any) as unknown as Primitive);
    return this;
  }

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
