/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EventContract } from '~/event.ts';
import type {
  ChannelPattern,
  ChannelPrimitive,
} from '~/channel/channel.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
import type {
  HandlerCtxFromState,
  NextState,
  ScopeState,
  ScopeStateShape,
} from '~/_types/scope-state.ts';
import { channel as createChannel } from '~/channel/channel.ts';
import {
  onBeforeSubscribe as createOnBeforeSubscribe,
  onSubscribe as createOnSubscribe,
  onUnsubscribe as createOnUnsubscribe,
} from '~/channel/lifecycle.ts';
import { incoming as createIncoming } from '~/incoming/incoming.ts';
import { outgoing as createOutgoing } from '~/outgoing/outgoing.ts';
import { received } from '~/received.ts';
import { t } from '~/t.ts';
import { ServerBuilder, GroupBuilder } from '~/_builder/server-builder.ts';

type ChannelState<TParentState extends ScopeStateShape> = ScopeState<
  'channel',
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

export class ChannelBuilder<TParentState extends ScopeStateShape, TState extends ScopeStateShape = ChannelState<TParentState>> {
  /** @internal */
  readonly _parentBuilder: ServerBuilder<TParentState> | GroupBuilder<TParentState>;
  /** @internal */
  readonly _parentPrimitives: Primitive[];
  /** @internal */
  readonly _primitives: Primitive[] = [];
  /** @internal */
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

  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): ChannelBuilder<TParentState, StateAfterOutgoing<TState, TEvent, TPayload>> {
    this._primitives.push(
      createOutgoing(eventContract.event, t<TPayload>()) as unknown as Primitive,
    );
    return this as any;
  }

  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): ChannelBuilder<TParentState, StateAfterIncoming<TState, TEvent, TPayload>> {
    this._primitives.push(
      createIncoming(
        received(eventContract.event, eventContract.schema as any),
        handler as any,
      ) as unknown as Primitive,
    );
    return this as any;
  }

  onBeforeSubscribe(
    handler: (ctx: HandlerCtxFromState<TState>, data?: unknown) => void | Promise<void>,
  ): this {
    this._primitives.push(createOnBeforeSubscribe(handler as any) as unknown as Primitive);
    return this;
  }

  onSubscribe(
    handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
  ): this {
    this._primitives.push(createOnSubscribe(handler as any) as unknown as Primitive);
    return this;
  }

  onUnsubscribe(
    handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
  ): this {
    this._primitives.push(createOnUnsubscribe(handler as any) as unknown as Primitive);
    return this;
  }

  done(): ServerBuilder<TParentState> {
    const channelPrimitive = (createChannel as any)(
      this._pattern,
      ...this._primitives,
    ) as Primitive;
    this._parentPrimitives.push(channelPrimitive);
    return this._parentBuilder as any;
  }

  extract(): ChannelPrimitive {
    return (createChannel as any)(
      this._pattern,
      ...this._primitives,
    ) as ChannelPrimitive;
  }
}

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    channel(pattern: ChannelPattern): ChannelBuilder<TState>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    channel(pattern: ChannelPattern): ChannelBuilder<TState>;
  }
}

ServerBuilder.prototype.channel = function (this: ServerBuilder<any>, pattern: ChannelPattern) {
  return new ChannelBuilder(this, this._primitives, pattern);
};

GroupBuilder.prototype.channel = function (this: GroupBuilder<any>, pattern: ChannelPattern) {
  return new ChannelBuilder(this as any, this._primitives, pattern);
};
