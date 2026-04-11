/* oxlint-disable @typescript-eslint/no-explicit-any */
import type * as AckModule from '~/ack/index.ts';
import type * as ChannelModule from '~/channel/index.ts';
import type { ChannelManager, InitContext, ShutdownContext, TaskContext } from '~/context.ts';
import type * as DedupModule from '~/dedup/index.ts';
import type * as ErrorsModule from '~/errors/index.ts';
import type * as HeartbeatModule from '~/heartbeat/index.ts';
import type * as HibernationModule from '~/hibernation/index.ts';
import type * as IncomingModule from '~/incoming/index.ts';
import type * as InterceptModule from '~/intercept/index.ts';
import type * as LifecycleModule from '~/lifecycle.ts';
import type * as NamespaceModule from '~/namespace/index.ts';
import type * as OutgoingModule from '~/outgoing/index.ts';
import type * as PassiveModule from '~/passive/index.ts';
import type { ReceivedEvent } from '~/received.ts';
import type * as ReplayModule from '~/replay/index.ts';
import type * as RequestModule from '~/request/index.ts';
import type * as ScheduledModule from '~/scheduled/index.ts';
import type * as SequenceModule from '~/sequence/index.ts';
import type * as StreamModule from '~/stream/index.ts';
import type {
  HasRegisteredChannelCtx,
  HasRegisteredCtx,
  HasRegisteredIncomingCtx,
  HasRegisteredNamespaceCtx,
  HasRegisteredPostInterceptCtx,
  HasRegisteredRequestCtx,
  RegisteredChannelCtx,
  RegisteredCtx,
  RegisteredIncomingCtx,
  RegisteredNamespaceCtx,
  RegisteredOutgoing,
  RegisteredPostInterceptCtx,
  RegisteredRequestCtx,
} from './registry-types.ts';

export type AckFactory = typeof AckModule.ack;
export type ChannelFactory = typeof ChannelModule.channel;
export type DedupFactory = typeof DedupModule.dedup;
export type ErrorsFactory = typeof ErrorsModule.errors;
export type HeartbeatFactory = typeof HeartbeatModule.heartbeat;
export type HibernationFactory = typeof HibernationModule.hibernation;
export type IncomingFactory = typeof IncomingModule.incoming;
export type InterceptFactory = typeof InterceptModule.intercept;
export type OnBeforeSubscribeFactory = typeof ChannelModule._onBeforeSubscribe;
export type OnBinaryFactory = typeof LifecycleModule.onBinary;
export type OnConnectFactory = typeof LifecycleModule.onConnect;
export type OnDisconnectFactory = typeof LifecycleModule.onDisconnect;
export type OnErrorFactory = typeof LifecycleModule.onError;
export type OnInitFactory = typeof LifecycleModule.onInit;
export type OnShutdownFactory = typeof LifecycleModule.onShutdown;
export type OnSubscribeFactory = typeof ChannelModule._onSubscribe;
export type OnUnsubscribeFactory = typeof ChannelModule._onUnsubscribe;
export type OnUpgradeFactory = typeof LifecycleModule.onUpgrade;
export type OnValidationErrorFactory = typeof LifecycleModule.onValidationError;
export type NamespaceFactory = typeof NamespaceModule.namespace;
export type OutgoingFactory = typeof OutgoingModule.outgoing;
export type PassiveFactory = typeof PassiveModule.passive;
export type ReplayFactory = typeof ReplayModule.replay;
export type RequestFactory = typeof RequestModule.request;
export type ScheduledFactory = typeof ScheduledModule.scheduled;
export type SequenceFactory = typeof SequenceModule.sequence;
export type StreamFactory = typeof StreamModule.stream;

export type ServerPrimitiveFactories = Partial<{
  _ack: AckFactory;
  _channel: ChannelFactory;
  _dedup: DedupFactory;
  _errors: ErrorsFactory;
  _heartbeat: HeartbeatFactory;
  _hibernation: HibernationFactory;
  _incoming: IncomingFactory;
  _intercept: InterceptFactory;
  _onBeforeSubscribe: OnBeforeSubscribeFactory;
  _onBinary: OnBinaryFactory;
  _onConnect: OnConnectFactory;
  _onDisconnect: OnDisconnectFactory;
  _onError: OnErrorFactory;
  _onInit: OnInitFactory;
  _onShutdown: OnShutdownFactory;
  _onSubscribe: OnSubscribeFactory;
  _onUnsubscribe: OnUnsubscribeFactory;
  _onUpgrade: OnUpgradeFactory;
  _onValidationError: OnValidationErrorFactory;
  _namespace: NamespaceFactory;
  _outgoing: OutgoingFactory;
  _passive: PassiveFactory;
  _replay: ReplayFactory;
  _request: RequestFactory;
  _scheduled: ScheduledFactory;
  _sequence: SequenceFactory;
  _stream: StreamFactory;
}>;

type GenericSendApi = {
  send(event: string, payload: unknown): void;
  broadcast(event: string, payload: unknown): void;
  /**
   * Send an event to every connection that currently has the given tag.
   */
  sendTo(tag: string, event: string, payload: unknown): void;
};

type ConnectionIdentityApi = {
  /**
   * The unique ID for the current websocket connection.
   *
   * You can store this when you need to target this exact client later.
   */
  readonly id: string;
};

type ConnectionMetaApi = {
  /**
   * Metadata attached to this connection during the websocket upgrade step.
   *
   * This is commonly used for things like user IDs or session details.
   */
  readonly meta: Record<string, unknown>;
};

type BufferedAmountApi = {
  /**
   * The number of bytes still queued to be sent to this connection.
   *
   * This is useful when you want to detect backpressure and avoid sending too
   * much too quickly.
   */
  readonly bufferedAmount: number;
};

type LatencyApi = {
  /**
   * The latest measured round-trip latency for this connection in milliseconds.
   *
   * This stays `null` until wskit has enough ping/pong data to measure it.
   */
  readonly latency: number | null;
};

type QualityApi = {
  /**
   * A simple health label for the current connection.
   *
   * This is derived from recent ping/pong latency measurements so you do not
   * have to interpret the raw numbers yourself.
   */
  readonly quality: 'excellent' | 'good' | 'degraded' | 'poor';
};

type ConnectionTagsApi = {
  /**
   * The current tags attached to this connection.
   *
   * Tags make it easier to target groups of clients later.
   */
  readonly tags: readonly string[];
};

type TagApi = {
  /**
   * Attach a tag to the current connection.
   *
   * This is useful when you want to target this connection later as part of a
   * group.
   */
  tag(label: string): void;
};

type UntagApi = {
  /**
   * Remove a tag from the current connection.
   *
   * This is useful when the connection should no longer be part of a targeted
   * group.
   */
  untag(label: string): void;
};

type ExactSendApi<TOutgoing extends Record<string, unknown>> = keyof TOutgoing extends never
  ? {}
  : {
      send<TEvent extends keyof TOutgoing & string>(
        event: TEvent,
        payload: TOutgoing[TEvent],
      ): void;
      broadcast<TEvent extends keyof TOutgoing & string>(
        event: TEvent,
        payload: TOutgoing[TEvent],
      ): void;
    };

type GenericSendToApi = {
  /**
   * Send an event to every connection that currently has the given tag.
   */
  sendTo(tag: string, event: string, payload: unknown): void;
};

type ExactSendToApi<TOutgoing extends Record<string, unknown>> = keyof TOutgoing extends never
  ? GenericSendToApi
  : {
      /**
       * Send an event to every connection that currently has the given tag.
       *
       * Only events declared with `outgoing()` in the same scope are allowed.
       */
      sendTo<TEvent extends keyof TOutgoing & string>(
        tag: string,
        event: TEvent,
        payload: TOutgoing[TEvent],
      ): void;
    };

type SendApi<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = '_outgoing' extends keyof TFactories
  ? keyof RegisteredOutgoing<TName> extends never
    ? GenericSendApi
    : ExactSendApi<RegisteredOutgoing<TName>>
  : {};

type SendToApi<TName extends string> = keyof RegisteredOutgoing<TName> extends never
  ? GenericSendToApi
  : ExactSendToApi<RegisteredOutgoing<TName>>;

type AckApi<TFactories extends ServerPrimitiveFactories> = '_ack' extends keyof TFactories
  ? { ack(): void }
  : {};

type ChannelsApi<TFactories extends ServerPrimitiveFactories> = '_channel' extends keyof TFactories
  ? { channels: ChannelManager<Record<string, unknown>> }
  : {};

export type ReplayMeta = { seq: number; messageId: string };

type GenericReplayApi = {
  sendReplay(event: string, payload: unknown, meta: ReplayMeta): void;
};

type ExactReplayApi<TOutgoing extends Record<string, unknown>> = keyof TOutgoing extends never
  ? {}
  : {
      sendReplay<TEvent extends keyof TOutgoing & string>(
        event: TEvent,
        payload: TOutgoing[TEvent],
        meta: ReplayMeta,
      ): void;
    };

type ReplayApi<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = '_replay' extends keyof TFactories
  ? keyof RegisteredOutgoing<TName> extends never
    ? GenericReplayApi
    : ExactReplayApi<RegisteredOutgoing<TName>>
  : {};

export type BoundServerContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = (HasRegisteredCtx<TName> extends true
  ? RegisteredCtx<TName>
  : ConnectionIdentityApi &
      ConnectionMetaApi &
      BufferedAmountApi &
      LatencyApi &
      QualityApi &
      ConnectionTagsApi &
      TagApi &
      UntagApi &
      SendToApi<TName> &
      SendApi<TName, TFactories> &
      AckApi<TFactories> &
      ReplayApi<TName, TFactories>) &
  ChannelsApi<TFactories>;

export type BoundInitContext = InitContext<Record<string, unknown>, unknown>;
export type BoundShutdownContext = ShutdownContext<
  Record<string, unknown>,
  Record<string, unknown>,
  unknown
>;
export type BoundTaskContext = TaskContext<
  Record<string, unknown>,
  Record<string, unknown>,
  unknown
>;

type GenericScopeApi<TName extends string> = {
  name: TName;
  send(event: string, payload: unknown): void;
  broadcast(event: string, payload: unknown): void;
};

type BoundNamespaceFallbackContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TNamespace extends string,
> = BoundServerContext<TName, TFactories> & {
  namespace: GenericScopeApi<TNamespace>;
};

export type BoundNamespaceContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TNamespace extends string,
> = (HasRegisteredNamespaceCtx<TName, TNamespace> extends true
  ? RegisteredNamespaceCtx<TName, TNamespace>
  : BoundNamespaceFallbackContext<TName, TFactories, TNamespace>) &
  ChannelsApi<TFactories>;

type BoundChannelFallbackContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TChannel extends string,
> = BoundServerContext<TName, TFactories> & {
  channel: GenericScopeApi<TChannel>;
};

export type BoundChannelContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TChannel extends string,
> = (HasRegisteredChannelCtx<TName, TChannel> extends true
  ? RegisteredChannelCtx<TName, TChannel>
  : BoundChannelFallbackContext<TName, TFactories, TChannel>) &
  ChannelsApi<TFactories>;

export type EventBoundIncomingContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TEvent extends string,
> = (HasRegisteredIncomingCtx<TName, TEvent> extends true
  ? RegisteredIncomingCtx<TName, TEvent>
  : BoundServerContext<TName, TFactories>) &
  ChannelsApi<TFactories>;

export type EventBoundRequestContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TEvent extends string,
> = (HasRegisteredRequestCtx<TName, TEvent> extends true
  ? RegisteredRequestCtx<TName, TEvent>
  : BoundServerContext<TName, TFactories>) &
  ChannelsApi<TFactories>;

export type EventBoundPostInterceptContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TEvent extends string,
> = (HasRegisteredPostInterceptCtx<TName, TEvent> extends true
  ? RegisteredPostInterceptCtx<TName, TEvent>
  : BoundServerContext<TName, TFactories>) &
  ChannelsApi<TFactories>;

export type EventPayload<TReceived extends ReceivedEvent<string, unknown>> =
  TReceived extends ReceivedEvent<string, infer TPayload> ? TPayload : never;

export type EventName<TReceived extends ReceivedEvent<string, unknown>> =
  TReceived extends ReceivedEvent<infer TEvent, unknown> ? TEvent : never;
