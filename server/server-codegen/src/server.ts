/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { ack as ackPrimitive } from './ack/index.ts';
import {
  _onBeforeSubscribe as onBeforeSubscribePrimitive,
  _onSubscribe as onSubscribePrimitive,
  _onUnsubscribe as onUnsubscribePrimitive,
} from './channel/index.ts';
import { dedup as dedupPrimitive } from './dedup/index.ts';
import { defineServer } from './define-server.ts';
import { heartbeat as heartbeatPrimitive } from './heartbeat/index.ts';
import { hibernation as hibernationPrimitive } from './hibernation/index.ts';
import { passive as passivePrimitive } from './passive/index.ts';
import { replay as replayPrimitive } from './replay/index.ts';
import { sequence as sequencePrimitive } from './sequence/index.ts';
import type * as AckModule from './ack/index.ts';
import type * as ChannelModule from './channel/index.ts';
import type {
  BeforeSubscribeHandler,
  BeforeSubscribePrimitive,
  ChannelPattern,
  ChannelPrimitive,
  SubscribeHandler,
  SubscribePrimitive,
  UnsubscribeHandler,
  UnsubscribePrimitive,
} from './channel/index.ts';
import type { ChannelManager, InitContext, ShutdownContext, TaskContext } from './context.ts';
import type * as DedupModule from './dedup/index.ts';
import type * as ErrorsModule from './errors/index.ts';
import type * as HeartbeatModule from './heartbeat/index.ts';
import type * as HibernationModule from './hibernation/index.ts';
import type * as IncomingModule from './incoming/index.ts';
import type { IncomingHandler, IncomingPrimitive } from './incoming/index.ts';
import type * as InterceptModule from './intercept/index.ts';
import type {
  PostInterceptHandler,
  PostInterceptPrimitive,
  PreInterceptHandler,
  PreInterceptPrimitive,
} from './intercept/index.ts';
import type * as LifecycleModule from './lifecycle.ts';
import type {
  BinaryHandler,
  BinaryPrimitive,
  ConnectHandler,
  ConnectPrimitive,
  DisconnectHandler,
  DisconnectPrimitive,
  ErrorHandler,
  ErrorPrimitive,
  InitHandler,
  InitPrimitive,
  ShutdownHandler,
  ShutdownPrimitive,
  UpgradeHandler,
  UpgradePrimitive,
  ValidationErrorHandler,
  ValidationErrorPrimitive,
} from './lifecycle.ts';
import type * as NamespaceModule from './namespace/index.ts';
import type { NamespacePrimitive } from './namespace/index.ts';
import type * as OutgoingModule from './outgoing/index.ts';
import type { OutgoingPrimitive } from './outgoing/index.ts';
import type * as PassiveModule from './passive/index.ts';
import type { PassiveChild } from './passive/index.ts';
import type { ReceivedEvent } from './received.ts';
import type * as ReplayModule from './replay/index.ts';
import type { ReplayPrimitive } from './replay/index.ts';
import type * as RequestModule from './request/index.ts';
import type { RequestHandler, RequestPrimitive } from './request/index.ts';
import type * as ScheduledModule from './scheduled/index.ts';
import type { ScheduledHandler, ScheduledOptions, ScheduledPrimitive } from './scheduled/index.ts';
import type * as SequenceModule from './sequence/index.ts';
import type * as StreamModule from './stream/index.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from './stream/index.ts';
import type { TypeMarker } from './t.ts';

const DEFAULT_HEARTBEAT_TIMEOUT = 30_000;

type AckFactory = typeof AckModule.ack;
type ChannelFactory = typeof ChannelModule.channel;
type DedupFactory = typeof DedupModule.dedup;
type ErrorsFactory = typeof ErrorsModule.errors;
type HeartbeatFactory = typeof HeartbeatModule.heartbeat;
type HibernationFactory = typeof HibernationModule.hibernation;
type IncomingFactory = typeof IncomingModule.incoming;
type InterceptFactory = typeof InterceptModule.intercept;
type OnBeforeSubscribeFactory = typeof ChannelModule._onBeforeSubscribe;
type OnBinaryFactory = typeof LifecycleModule.onBinary;
type OnConnectFactory = typeof LifecycleModule.onConnect;
type OnDisconnectFactory = typeof LifecycleModule.onDisconnect;
type OnErrorFactory = typeof LifecycleModule.onError;
type OnInitFactory = typeof LifecycleModule.onInit;
type OnShutdownFactory = typeof LifecycleModule.onShutdown;
type OnSubscribeFactory = typeof ChannelModule._onSubscribe;
type OnUnsubscribeFactory = typeof ChannelModule._onUnsubscribe;
type OnUpgradeFactory = typeof LifecycleModule.onUpgrade;
type OnValidationErrorFactory = typeof LifecycleModule.onValidationError;
type NamespaceFactory = typeof NamespaceModule.namespace;
type OutgoingFactory = typeof OutgoingModule.outgoing;
type PassiveFactory = typeof PassiveModule.passive;
type ReplayFactory = typeof ReplayModule.replay;
type RequestFactory = typeof RequestModule.request;
type ScheduledFactory = typeof ScheduledModule.scheduled;
type SequenceFactory = typeof SequenceModule.sequence;
type StreamFactory = typeof StreamModule.stream;

type RegisteredServer<TName extends string> = TName extends keyof WskitServerRegistry
  ? WskitServerRegistry[TName]
  : {};

type RegisteredOutgoing<TName extends string> =
  RegisteredServer<TName> extends {
    outgoing: infer TOutgoing extends Record<string, unknown>;
  }
    ? TOutgoing
    : {};

type RegisteredCtx<TName extends string> =
  RegisteredServer<TName> extends {
    ctx: infer TCtx;
  }
    ? TCtx
    : {};

type HasRegisteredCtx<TName extends string> = keyof RegisteredCtx<TName> extends never
  ? false
  : true;

type RegisteredIncomingContexts<TName extends string> =
  RegisteredServer<TName> extends {
    incomingContexts: infer TContexts extends Record<string, unknown>;
  }
    ? TContexts
    : {};

type RegisteredIncomingCtx<
  TName extends string,
  TEvent extends string,
> = TEvent extends keyof RegisteredIncomingContexts<TName>
  ? RegisteredIncomingContexts<TName>[TEvent]
  : never;

type HasRegisteredIncomingCtx<TName extends string, TEvent extends string> = [
  RegisteredIncomingCtx<TName, TEvent>,
] extends [never]
  ? false
  : true;

type RegisteredRequestContexts<TName extends string> =
  RegisteredServer<TName> extends {
    requestContexts: infer TContexts extends Record<string, unknown>;
  }
    ? TContexts
    : {};

type RegisteredRequestCtx<
  TName extends string,
  TEvent extends string,
> = TEvent extends keyof RegisteredRequestContexts<TName>
  ? RegisteredRequestContexts<TName>[TEvent]
  : never;

type HasRegisteredRequestCtx<TName extends string, TEvent extends string> = [
  RegisteredRequestCtx<TName, TEvent>,
] extends [never]
  ? false
  : true;

type RegisteredPostInterceptContexts<TName extends string> =
  RegisteredServer<TName> extends {
    postInterceptContexts: infer TContexts extends Record<string, unknown>;
  }
    ? TContexts
    : {};

type RegisteredPostInterceptCtx<
  TName extends string,
  TEvent extends string,
> = TEvent extends keyof RegisteredPostInterceptContexts<TName>
  ? RegisteredPostInterceptContexts<TName>[TEvent]
  : never;

type HasRegisteredPostInterceptCtx<TName extends string, TEvent extends string> = [
  RegisteredPostInterceptCtx<TName, TEvent>,
] extends [never]
  ? false
  : true;

type RegisteredNamespaces<TName extends string> =
  RegisteredServer<TName> extends {
    namespaces: infer TNamespaces extends Record<string, unknown>;
  }
    ? TNamespaces
    : {};

type RegisteredNamespaceCtx<
  TName extends string,
  TNamespace extends string,
> = TNamespace extends keyof RegisteredNamespaces<TName>
  ? RegisteredNamespaces<TName>[TNamespace] extends { ctx: infer TCtx }
    ? TCtx
    : {}
  : {};

type HasRegisteredNamespaceCtx<
  TName extends string,
  TNamespace extends string,
> = keyof RegisteredNamespaceCtx<TName, TNamespace> extends never ? false : true;

type RegisteredChannels<TName extends string> =
  RegisteredServer<TName> extends {
    channels: infer TChannels extends Record<string, unknown>;
  }
    ? TChannels
    : {};

type RegisteredChannelCtx<
  TName extends string,
  TChannel extends string,
> = TChannel extends keyof RegisteredChannels<TName>
  ? RegisteredChannels<TName>[TChannel] extends { ctx: infer TCtx }
    ? TCtx
    : {}
  : {};

type HasRegisteredChannelCtx<
  TName extends string,
  TChannel extends string,
> = keyof RegisteredChannelCtx<TName, TChannel> extends never ? false : true;

type GenericSendApi = {
  send(event: string, payload: unknown): void;
  broadcast(event: string, payload: unknown): void;
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

type SendApi<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = '_outgoing' extends keyof TFactories
  ? keyof RegisteredOutgoing<TName> extends never
    ? GenericSendApi
    : ExactSendApi<RegisteredOutgoing<TName>>
  : {};

type AckApi<TFactories extends ServerPrimitiveFactories> = '_ack' extends keyof TFactories
  ? { ack(): void }
  : {};

type ChannelsApi<TFactories extends ServerPrimitiveFactories> = '_channel' extends keyof TFactories
  ? { channels: ChannelManager<Record<string, unknown>> }
  : {};

type ReplayMeta = { seq: number; messageId: string };

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
      SendApi<TName, TFactories> &
      AckApi<TFactories> &
      ReplayApi<TName, TFactories>) &
  ChannelsApi<TFactories>;

type BoundInitContext = InitContext<Record<string, unknown>, unknown>;
type BoundShutdownContext = ShutdownContext<
  Record<string, unknown>,
  Record<string, unknown>,
  unknown
>;
type BoundTaskContext = TaskContext<Record<string, unknown>, Record<string, unknown>, unknown>;

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

type BoundNamespaceContext<
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

type BoundChannelContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TChannel extends string,
> = (HasRegisteredChannelCtx<TName, TChannel> extends true
  ? RegisteredChannelCtx<TName, TChannel>
  : BoundChannelFallbackContext<TName, TFactories, TChannel>) &
  ChannelsApi<TFactories>;

type EventBoundIncomingContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TEvent extends string,
> = (HasRegisteredIncomingCtx<TName, TEvent> extends true
  ? RegisteredIncomingCtx<TName, TEvent>
  : BoundServerContext<TName, TFactories>) &
  ChannelsApi<TFactories>;

type EventBoundRequestContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TEvent extends string,
> = (HasRegisteredRequestCtx<TName, TEvent> extends true
  ? RegisteredRequestCtx<TName, TEvent>
  : BoundServerContext<TName, TFactories>) &
  ChannelsApi<TFactories>;

type EventBoundPostInterceptContext<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TEvent extends string,
> = (HasRegisteredPostInterceptCtx<TName, TEvent> extends true
  ? RegisteredPostInterceptCtx<TName, TEvent>
  : BoundServerContext<TName, TFactories>) &
  ChannelsApi<TFactories>;

type EventPayload<TReceived extends ReceivedEvent<string, unknown>> =
  TReceived extends ReceivedEvent<string, infer TPayload> ? TPayload : never;

type EventName<TReceived extends ReceivedEvent<string, unknown>> =
  TReceived extends ReceivedEvent<infer TEvent, unknown> ? TEvent : never;

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

type StripUnderscore<TName extends string> = TName extends `_${infer TStripped}`
  ? TStripped
  : TName;

type BoundIncomingFactory<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = '_incoming' extends keyof TFactories
  ? {
      <TReceived extends ReceivedEvent<string, unknown>>(
        event: TReceived,
        handler: IncomingHandler<
          EventBoundIncomingContext<TName, TFactories, EventName<TReceived>>,
          EventPayload<TReceived>
        >,
      ): IncomingPrimitive<
        EventName<TReceived>,
        EventPayload<TReceived>,
        EventBoundIncomingContext<TName, TFactories, EventName<TReceived>>
      >;
      <TCtx, TReceived extends ReceivedEvent<string, unknown>>(
        event: TReceived,
        handler: IncomingHandler<TCtx, EventPayload<TReceived>>,
      ): IncomingPrimitive<EventName<TReceived>, EventPayload<TReceived>, TCtx>;
    }
  : never;

type BoundRequestFactory<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = '_request' extends keyof TFactories
  ? {
      <TEvent extends string, TResponse>(
        event: TEvent,
        handler: RequestHandler<
          EventBoundRequestContext<TName, TFactories, TEvent>,
          unknown,
          TResponse
        >,
      ): RequestPrimitive<
        TEvent,
        unknown,
        TResponse,
        EventBoundRequestContext<TName, TFactories, TEvent>
      >;
      <TEvent extends string, TPayload, TResponse>(
        event: TEvent,
        handler: RequestHandler<
          EventBoundRequestContext<TName, TFactories, TEvent>,
          TPayload,
          TResponse
        >,
        options: { validator: (value: unknown) => TPayload },
      ): RequestPrimitive<
        TEvent,
        TPayload,
        TResponse,
        EventBoundRequestContext<TName, TFactories, TEvent>
      >;
      <TEvent extends string, TSchema extends StandardSchemaV1, TResponse>(
        event: TEvent,
        handler: RequestHandler<
          EventBoundRequestContext<TName, TFactories, TEvent>,
          StandardSchemaV1.InferOutput<TSchema>,
          TResponse
        >,
        options: { validator: TSchema },
      ): RequestPrimitive<
        TEvent,
        StandardSchemaV1.InferOutput<TSchema>,
        TResponse,
        EventBoundRequestContext<TName, TFactories, TEvent>
      >;
      <TCtx, TEvent extends string, TResponse>(
        event: TEvent,
        handler: RequestHandler<TCtx, unknown, TResponse>,
      ): RequestPrimitive<TEvent, unknown, TResponse, TCtx>;
      <TCtx, TEvent extends string, TPayload, TResponse>(
        event: TEvent,
        handler: RequestHandler<TCtx, TPayload, TResponse>,
        options: { validator: (value: unknown) => TPayload },
      ): RequestPrimitive<TEvent, TPayload, TResponse, TCtx>;
      <TCtx, TEvent extends string, TSchema extends StandardSchemaV1, TResponse>(
        event: TEvent,
        handler: RequestHandler<TCtx, StandardSchemaV1.InferOutput<TSchema>, TResponse>,
        options: { validator: TSchema },
      ): RequestPrimitive<TEvent, StandardSchemaV1.InferOutput<TSchema>, TResponse, TCtx>;
    }
  : never;

type BoundInterceptFactory<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = '_intercept' extends keyof TFactories
  ? {
      (
        handler: PreInterceptHandler<BoundServerContext<TName, TFactories>>,
      ): PreInterceptPrimitive<BoundServerContext<TName, TFactories>>;
      <TCtx>(handler: PreInterceptHandler<TCtx>): PreInterceptPrimitive<TCtx>;
      <TEvent extends string, TPayload>(
        event: TEvent,
        handler: PostInterceptHandler<
          EventBoundPostInterceptContext<TName, TFactories, TEvent>,
          TPayload
        >,
      ): PostInterceptPrimitive<
        TEvent,
        TPayload,
        EventBoundPostInterceptContext<TName, TFactories, TEvent>
      >;
      <TCtx, TEvent extends string, TPayload>(
        event: TEvent,
        handler: PostInterceptHandler<TCtx, TPayload>,
      ): PostInterceptPrimitive<TEvent, TPayload, TCtx>;
    }
  : never;

type BoundScheduledFactory = {
  <TTaskId extends string, TData>(
    taskId: TTaskId,
    handler: ScheduledHandler<BoundTaskContext, TData>,
    options?: ScheduledOptions<TData>,
  ): ScheduledPrimitive<TTaskId, TData, BoundTaskContext>;
  <TTaskId extends string, TData>(
    taskId: TTaskId,
    data: TypeMarker<TData>,
    options?: ScheduledOptions<TData>,
  ): ScheduledPrimitive<TTaskId, TData>;
};

type BoundOnInitFactory = {
  (handler: InitHandler<BoundInitContext>): InitPrimitive<BoundInitContext>;
};

type BoundOnConnectFactory<TName extends string, TFactories extends ServerPrimitiveFactories> = {
  (
    handler: ConnectHandler<BoundServerContext<TName, TFactories>>,
  ): ConnectPrimitive<BoundServerContext<TName, TFactories>>;
};

type BoundOnDisconnectFactory<TName extends string, TFactories extends ServerPrimitiveFactories> = {
  (
    handler: DisconnectHandler<BoundServerContext<TName, TFactories>>,
  ): DisconnectPrimitive<BoundServerContext<TName, TFactories>>;
};

type BoundOnShutdownFactory = {
  (handler: ShutdownHandler<BoundShutdownContext>): ShutdownPrimitive<BoundShutdownContext>;
};

type BoundOnErrorFactory<TName extends string, TFactories extends ServerPrimitiveFactories> = {
  (
    handler: ErrorHandler<BoundServerContext<TName, TFactories>>,
  ): ErrorPrimitive<BoundServerContext<TName, TFactories>>;
};

type BoundOnBinaryFactory<TName extends string, TFactories extends ServerPrimitiveFactories> = {
  (
    handler: BinaryHandler<BoundServerContext<TName, TFactories>>,
  ): BinaryPrimitive<BoundServerContext<TName, TFactories>>;
};

type BoundOnValidationErrorFactory<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = {
  (
    handler: ValidationErrorHandler<BoundServerContext<TName, TFactories>>,
  ): ValidationErrorPrimitive<BoundServerContext<TName, TFactories>>;
};

type BoundOnUpgradeFactory = {
  (handler: UpgradeHandler): UpgradePrimitive;
};

type BoundOnBeforeSubscribeFactory<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = {
  <TChannel extends string, TData = unknown>(
    handler: BeforeSubscribeHandler<BoundChannelContext<TName, TFactories, TChannel>, TData>,
    options?: { validator?: (value: unknown) => TData } | { validator?: StandardSchemaV1 },
  ): BeforeSubscribePrimitive<BoundChannelContext<TName, TFactories, TChannel>, TData>;
};

type BoundOnSubscribeFactory<TName extends string, TFactories extends ServerPrimitiveFactories> = {
  <TChannel extends string>(
    handler: SubscribeHandler<BoundChannelContext<TName, TFactories, TChannel>>,
  ): SubscribePrimitive<BoundChannelContext<TName, TFactories, TChannel>>;
};

type BoundOnUnsubscribeFactory<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = {
  <TChannel extends string>(
    handler: UnsubscribeHandler<BoundChannelContext<TName, TFactories, TChannel>>,
  ): UnsubscribePrimitive<BoundChannelContext<TName, TFactories, TChannel>>;
};

type AnyStream = StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>;
type AnyIncomingPrimitive<TCtx> = IncomingPrimitive<string, any, TCtx>;
type AnyRequestPrimitive<TCtx> = RequestPrimitive<string, any, any, TCtx>;
type AnyGeneratePrimitive<TCtx> = GeneratePrimitive<AnyStream, TCtx, any>;
type AnyPreInterceptPrimitive<TCtx> = PreInterceptPrimitive<TCtx>;
type AnyPostInterceptPrimitive<TCtx> = PostInterceptPrimitive<string, any, TCtx>;
type AnyOutgoingPrimitive = OutgoingPrimitive<string, any>;

type BoundNamespaceChild<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TNamespace extends string,
> =
  | AnyOutgoingPrimitive
  | AnyPreInterceptPrimitive<BoundNamespaceContext<TName, TFactories, TNamespace>>
  | AnyPostInterceptPrimitive<BoundNamespaceContext<TName, TFactories, TNamespace>>
  | AnyIncomingPrimitive<BoundNamespaceContext<TName, TFactories, TNamespace>>
  | AnyRequestPrimitive<BoundNamespaceContext<TName, TFactories, TNamespace>>
  | AnyGeneratePrimitive<BoundNamespaceContext<TName, TFactories, TNamespace>>;

type BoundChannelChild<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
  TChannel extends string,
> =
  | ReplayPrimitive
  | AnyOutgoingPrimitive
  | BeforeSubscribePrimitive<BoundChannelContext<TName, TFactories, string>, any>
  | SubscribePrimitive<BoundChannelContext<TName, TFactories, string>>
  | UnsubscribePrimitive<BoundChannelContext<TName, TFactories, string>>
  | AnyPreInterceptPrimitive<BoundChannelContext<TName, TFactories, TChannel>>
  | AnyPostInterceptPrimitive<BoundChannelContext<TName, TFactories, TChannel>>
  | AnyIncomingPrimitive<BoundChannelContext<TName, TFactories, TChannel>>
  | AnyRequestPrimitive<BoundChannelContext<TName, TFactories, TChannel>>
  | AnyGeneratePrimitive<BoundChannelContext<TName, TFactories, TChannel>>;

type BoundNamespaceFactory<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = '_namespace' extends keyof TFactories
  ? {
      <const TPattern extends string, TEvent extends string, TPayload>(
        pattern: TPattern,
        p1: AnyOutgoingPrimitive,
        incomingPrimitive: IncomingPrimitive<
          TEvent,
          TPayload,
          BoundNamespaceContext<TName, TFactories, TPattern>
        >,
      ): NamespacePrimitive<
        TPattern,
        readonly [
          AnyOutgoingPrimitive,
          IncomingPrimitive<TEvent, TPayload, BoundNamespaceContext<TName, TFactories, TPattern>>,
        ]
      >;
      <const TPattern extends string, TEvent extends string, TPayload>(
        pattern: TPattern,
        p1: AnyOutgoingPrimitive,
        interceptPrimitive: PreInterceptPrimitive<
          BoundNamespaceContext<TName, TFactories, TPattern>
        >,
        incomingPrimitive: IncomingPrimitive<
          TEvent,
          TPayload,
          BoundNamespaceContext<TName, TFactories, TPattern>
        >,
      ): NamespacePrimitive<
        TPattern,
        readonly [
          AnyOutgoingPrimitive,
          PreInterceptPrimitive<BoundNamespaceContext<TName, TFactories, TPattern>>,
          IncomingPrimitive<TEvent, TPayload, BoundNamespaceContext<TName, TFactories, TPattern>>,
        ]
      >;
      <
        const TPattern extends string,
        TEvent extends string,
        TPayload,
        TRequestEvent extends string,
        TRequestPayload,
        TRequestResponse,
        TStream extends AnyStream,
      >(
        pattern: TPattern,
        p1: AnyOutgoingPrimitive,
        interceptPrimitive: PreInterceptPrimitive<
          BoundNamespaceContext<TName, TFactories, TPattern>
        >,
        incomingPrimitive: IncomingPrimitive<
          TEvent,
          TPayload,
          BoundNamespaceContext<TName, TFactories, TPattern>
        >,
        requestPrimitive: RequestPrimitive<
          TRequestEvent,
          TRequestPayload,
          TRequestResponse,
          BoundNamespaceContext<TName, TFactories, TPattern>
        >,
        generatePrimitive: GeneratePrimitive<
          TStream,
          BoundNamespaceContext<TName, TFactories, TPattern>,
          any
        >,
      ): NamespacePrimitive<
        TPattern,
        readonly [
          AnyOutgoingPrimitive,
          PreInterceptPrimitive<BoundNamespaceContext<TName, TFactories, TPattern>>,
          IncomingPrimitive<TEvent, TPayload, BoundNamespaceContext<TName, TFactories, TPattern>>,
          RequestPrimitive<
            TRequestEvent,
            TRequestPayload,
            TRequestResponse,
            BoundNamespaceContext<TName, TFactories, TPattern>
          >,
          GeneratePrimitive<TStream, BoundNamespaceContext<TName, TFactories, TPattern>, any>,
        ]
      >;
      <
        const TPattern extends string,
        const TPrimitives extends readonly BoundNamespaceChild<TName, TFactories, TPattern>[],
      >(
        pattern: TPattern,
        ...primitives: TPrimitives
      ): NamespacePrimitive<TPattern, TPrimitives>;
    }
  : never;

type ChannelKeyFor<TPattern extends ChannelPattern> = TPattern extends string
  ? TPattern
  : TPattern extends { key: infer TKey extends string }
    ? TKey
    : string;

type BoundChannelFactory<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = '_channel' extends keyof TFactories
  ? {
      <const TPattern extends ChannelPattern, TEvent extends string, TPayload>(
        pattern: TPattern,
        p1: AnyOutgoingPrimitive,
        incomingPrimitive: IncomingPrimitive<
          TEvent,
          TPayload,
          BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>
        >,
      ): ChannelPrimitive<
        TPattern,
        readonly [
          AnyOutgoingPrimitive,
          IncomingPrimitive<
            TEvent,
            TPayload,
            BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>
          >,
        ]
      >;
      <const TPattern extends ChannelPattern, TEvent extends string, TPayload, TData = unknown>(
        pattern: TPattern,
        p1: AnyOutgoingPrimitive,
        beforeSubscribePrimitive: BeforeSubscribePrimitive<
          BoundChannelContext<TName, TFactories, string>,
          TData
        >,
        subscribePrimitive: SubscribePrimitive<BoundChannelContext<TName, TFactories, string>>,
        unsubscribePrimitive: UnsubscribePrimitive<BoundChannelContext<TName, TFactories, string>>,
        incomingPrimitive: IncomingPrimitive<
          TEvent,
          TPayload,
          BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>
        >,
      ): ChannelPrimitive<
        TPattern,
        readonly [
          AnyOutgoingPrimitive,
          BeforeSubscribePrimitive<BoundChannelContext<TName, TFactories, string>, TData>,
          SubscribePrimitive<BoundChannelContext<TName, TFactories, string>>,
          UnsubscribePrimitive<BoundChannelContext<TName, TFactories, string>>,
          IncomingPrimitive<
            TEvent,
            TPayload,
            BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>
          >,
        ]
      >;
      <
        const TPattern extends ChannelPattern,
        TEvent extends string,
        TPayload,
        TRequestEvent extends string,
        TRequestPayload,
        TRequestResponse,
        TStream extends AnyStream,
      >(
        pattern: TPattern,
        p1: ReplayPrimitive | AnyOutgoingPrimitive,
        p2: AnyOutgoingPrimitive,
        p3: AnyOutgoingPrimitive,
        interceptPrimitive: PostInterceptPrimitive<
          string,
          any,
          BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>
        >,
        incomingPrimitive: IncomingPrimitive<
          TEvent,
          TPayload,
          BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>
        >,
        requestPrimitive: RequestPrimitive<
          TRequestEvent,
          TRequestPayload,
          TRequestResponse,
          BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>
        >,
        generatePrimitive: GeneratePrimitive<
          TStream,
          BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>,
          any
        >,
      ): ChannelPrimitive<
        TPattern,
        readonly [
          ReplayPrimitive | AnyOutgoingPrimitive,
          AnyOutgoingPrimitive,
          AnyOutgoingPrimitive,
          PostInterceptPrimitive<
            string,
            any,
            BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>
          >,
          IncomingPrimitive<
            TEvent,
            TPayload,
            BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>
          >,
          RequestPrimitive<
            TRequestEvent,
            TRequestPayload,
            TRequestResponse,
            BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>
          >,
          GeneratePrimitive<
            TStream,
            BoundChannelContext<TName, TFactories, ChannelKeyFor<TPattern>>,
            any
          >,
        ]
      >;
      <
        const TPattern extends ChannelPattern,
        const TPrimitives extends readonly BoundChannelChild<
          TName,
          TFactories,
          ChannelKeyFor<TPattern>
        >[],
      >(
        pattern: TPattern,
        ...primitives: TPrimitives
      ): ChannelPrimitive<TPattern, TPrimitives>;
    }
  : never;

type BoundPassthroughFactories<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = {
  [TKey in keyof TFactories as TKey extends
    | '_incoming'
    | '_request'
    | '_intercept'
    | '_namespace'
    | '_channel'
    | '_scheduled'
    | '_onInit'
    | '_onConnect'
    | '_onDisconnect'
    | '_onShutdown'
    | '_onError'
    | '_onUpgrade'
    | '_onBinary'
    | '_onValidationError'
    | '_onBeforeSubscribe'
    | '_onSubscribe'
    | '_onUnsubscribe'
    ? never
    : StripUnderscore<TKey & string>]-?: TFactories[TKey];
} & {
  incoming: BoundIncomingFactory<TName, TFactories>;
  request: BoundRequestFactory<TName, TFactories>;
  intercept: BoundInterceptFactory<TName, TFactories>;
  namespace: BoundNamespaceFactory<TName, TFactories>;
  channel: BoundChannelFactory<TName, TFactories>;
  scheduled: '_scheduled' extends keyof TFactories ? BoundScheduledFactory : never;
  onInit: '_onInit' extends keyof TFactories ? BoundOnInitFactory : never;
  onConnect: '_onConnect' extends keyof TFactories
    ? BoundOnConnectFactory<TName, TFactories>
    : never;
  onDisconnect: '_onDisconnect' extends keyof TFactories
    ? BoundOnDisconnectFactory<TName, TFactories>
    : never;
  onShutdown: '_onShutdown' extends keyof TFactories ? BoundOnShutdownFactory : never;
  onError: '_onError' extends keyof TFactories ? BoundOnErrorFactory<TName, TFactories> : never;
  onUpgrade: '_onUpgrade' extends keyof TFactories ? BoundOnUpgradeFactory : never;
  onBinary: '_onBinary' extends keyof TFactories ? BoundOnBinaryFactory<TName, TFactories> : never;
  onValidationError: '_onValidationError' extends keyof TFactories
    ? BoundOnValidationErrorFactory<TName, TFactories>
    : never;
  onBeforeSubscribe: BoundOnBeforeSubscribeFactory<TName, TFactories>;
  onSubscribe: BoundOnSubscribeFactory<TName, TFactories>;
  onUnsubscribe: BoundOnUnsubscribeFactory<TName, TFactories>;
};

export type BoundServer<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = BoundPassthroughFactories<TName, TFactories> & {
  readonly define: typeof defineServer;
  readonly name: TName;
};

function hasPrimitiveTag(value: unknown, tag: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasPrimitiveTag(entry, tag));
  }

  if (!value || typeof value !== 'object') return false;
  if ('__wskit' in value && value.__wskit === tag) return true;

  if ('primitives' in value && Array.isArray((value as { primitives?: unknown[] }).primitives)) {
    return (value as { primitives: unknown[] }).primitives.some((child) => {
      return hasPrimitiveTag(child, tag);
    });
  }

  return false;
}

function buildDefaultInfrastructure<TFactories extends ServerPrimitiveFactories>(
  factories: TFactories,
  explicitPrimitives: readonly unknown[],
): unknown[] {
  const injected: unknown[] = [];

  if ('_ack' in factories && !hasPrimitiveTag(explicitPrimitives, 'ack')) {
    injected.push((factories._ack ?? ackPrimitive)());
  }

  const passiveChildren: PassiveChild[] = [];

  if ('_heartbeat' in factories && !hasPrimitiveTag(explicitPrimitives, 'heartbeat')) {
    passiveChildren.push(
      (factories._heartbeat ?? heartbeatPrimitive)({ timeout: DEFAULT_HEARTBEAT_TIMEOUT }),
    );
  }

  if ('_sequence' in factories && !hasPrimitiveTag(explicitPrimitives, 'sequence')) {
    passiveChildren.push((factories._sequence ?? sequencePrimitive)());
  }

  if ('_dedup' in factories && !hasPrimitiveTag(explicitPrimitives, 'dedup')) {
    passiveChildren.push((factories._dedup ?? dedupPrimitive)());
  }

  if (passiveChildren.length) {
    if ('_passive' in factories) {
      injected.push((factories._passive ?? passivePrimitive)(...passiveChildren));
    } else {
      injected.push(...passiveChildren);
    }
  }

  if ('_replay' in factories && !hasPrimitiveTag(explicitPrimitives, 'replay')) {
    injected.push((factories._replay ?? replayPrimitive)());
  }

  if ('_hibernation' in factories && !hasPrimitiveTag(explicitPrimitives, 'hibernation')) {
    injected.push((factories._hibernation ?? hibernationPrimitive)(true));
  }

  return injected;
}

/**
 * Bind a set of imported primitive factories to one named server.
 *
 * The returned helpers keep the flat functional style, but they also give the
 * code generator one stable anchor: a server key plus a known primitive set.
 *
 * Things that are obvious from the primitive set are inferred directly.
 * Example: if you pass `_ack`, handlers get `ctx.ack()`.
 *
 * The hard exact pieces such as event maps come later from generated
 * `ServerRegistry` declarations written by `@wskit/server-vite`.
 */
export function server<
  const TName extends string,
  const TFactories extends ServerPrimitiveFactories,
>(name: TName, factories: TFactories): BoundServer<TName, TFactories> {
  const define = ((...primitives: readonly unknown[]) => {
    return defineServer(
      ...(buildDefaultInfrastructure(factories, primitives) as never[]),
      ...(primitives as never[]),
    );
  }) as typeof defineServer;

  const bound: Record<string, unknown> = {
    define,
    name,
  };

  for (const [key, value] of Object.entries(factories)) {
    const publicName = key.startsWith('_') ? key.slice(1) : key;

    if (publicName === 'incoming') {
      bound.incoming = ((
        event: ReceivedEvent<string, unknown>,
        handler: IncomingHandler<any, any>,
      ) => (value as (...args: any[]) => unknown)(event, handler)) as BoundIncomingFactory<
        TName,
        TFactories
      >;
      continue;
    }

    if (publicName === 'request') {
      bound.request = ((...args: any[]) => {
        return (value as (...inner: any[]) => unknown)(...args);
      }) as BoundRequestFactory<TName, TFactories>;
      continue;
    }

    if (publicName === 'scheduled') {
      bound.scheduled = ((...args: any[]) => {
        return (value as (...inner: any[]) => unknown)(...args);
      }) as BoundScheduledFactory;
      continue;
    }

    if (publicName === 'intercept') {
      bound.intercept = ((...args: any[]) => {
        return (value as (...inner: any[]) => unknown)(...args);
      }) as BoundInterceptFactory<TName, TFactories>;
      continue;
    }

    if (publicName === 'onInit') {
      bound.onInit = ((handler: InitHandler<BoundInitContext>) => {
        return (value as (inner: InitHandler<BoundInitContext>) => unknown)(handler);
      }) as BoundOnInitFactory;
      continue;
    }

    if (publicName === 'onConnect') {
      bound.onConnect = ((handler: ConnectHandler<BoundServerContext<TName, TFactories>>) => {
        return (value as (inner: ConnectHandler<BoundServerContext<TName, TFactories>>) => unknown)(
          handler,
        );
      }) as BoundOnConnectFactory<TName, TFactories>;
      continue;
    }

    if (publicName === 'onDisconnect') {
      bound.onDisconnect = ((handler: DisconnectHandler<BoundServerContext<TName, TFactories>>) => {
        return (
          value as (inner: DisconnectHandler<BoundServerContext<TName, TFactories>>) => unknown
        )(handler);
      }) as BoundOnDisconnectFactory<TName, TFactories>;
      continue;
    }

    if (publicName === 'onShutdown') {
      bound.onShutdown = ((handler: ShutdownHandler<BoundShutdownContext>) => {
        return (value as (inner: ShutdownHandler<BoundShutdownContext>) => unknown)(handler);
      }) as BoundOnShutdownFactory;
      continue;
    }

    if (publicName === 'onError') {
      bound.onError = ((handler: ErrorHandler<BoundServerContext<TName, TFactories>>) => {
        return (value as (inner: ErrorHandler<BoundServerContext<TName, TFactories>>) => unknown)(
          handler,
        );
      }) as BoundOnErrorFactory<TName, TFactories>;
      continue;
    }

    if (publicName === 'onUpgrade') {
      bound.onUpgrade = ((handler: UpgradeHandler) => {
        return (value as (inner: UpgradeHandler) => unknown)(handler);
      }) as BoundOnUpgradeFactory;
      continue;
    }

    if (publicName === 'onBinary') {
      bound.onBinary = ((handler: BinaryHandler<BoundServerContext<TName, TFactories>>) => {
        return (value as (inner: BinaryHandler<BoundServerContext<TName, TFactories>>) => unknown)(
          handler,
        );
      }) as BoundOnBinaryFactory<TName, TFactories>;
      continue;
    }

    if (publicName === 'onValidationError') {
      bound.onValidationError = ((
        handler: ValidationErrorHandler<BoundServerContext<TName, TFactories>>,
      ) => {
        return (
          value as (inner: ValidationErrorHandler<BoundServerContext<TName, TFactories>>) => unknown
        )(handler);
      }) as BoundOnValidationErrorFactory<TName, TFactories>;
      continue;
    }

    if (publicName === 'onBeforeSubscribe') {
      bound.onBeforeSubscribe = ((...args: any[]) => {
        return (value as (...inner: any[]) => unknown)(...args);
      }) as BoundOnBeforeSubscribeFactory<TName, TFactories>;
      continue;
    }

    if (publicName === 'onSubscribe') {
      bound.onSubscribe = ((handler: SubscribeHandler<any>) => {
        return (value as (inner: SubscribeHandler<any>) => unknown)(handler);
      }) as BoundOnSubscribeFactory<TName, TFactories>;
      continue;
    }

    if (publicName === 'onUnsubscribe') {
      bound.onUnsubscribe = ((handler: UnsubscribeHandler<any>) => {
        return (value as (inner: UnsubscribeHandler<any>) => unknown)(handler);
      }) as BoundOnUnsubscribeFactory<TName, TFactories>;
      continue;
    }

    if (publicName === 'namespace') {
      bound.namespace = ((...args: any[]) => {
        return (value as (...inner: any[]) => unknown)(...args);
      }) as BoundNamespaceFactory<TName, TFactories>;
      continue;
    }

    if (publicName === 'channel') {
      bound.channel = ((...args: any[]) => {
        return (value as (...inner: any[]) => unknown)(...args);
      }) as BoundChannelFactory<TName, TFactories>;
      continue;
    }

    bound[publicName] = value;
  }

  if (!('onBeforeSubscribe' in bound)) {
    const value = factories._onBeforeSubscribe ?? onBeforeSubscribePrimitive;
    bound.onBeforeSubscribe = ((...args: any[]) => {
      return (value as (...inner: any[]) => unknown)(...args);
    }) as BoundOnBeforeSubscribeFactory<TName, TFactories>;
  }

  if (!('onSubscribe' in bound)) {
    const value = factories._onSubscribe ?? onSubscribePrimitive;
    bound.onSubscribe = ((handler: SubscribeHandler<any>) => {
      return (value as (inner: SubscribeHandler<any>) => unknown)(handler);
    }) as BoundOnSubscribeFactory<TName, TFactories>;
  }

  if (!('onUnsubscribe' in bound)) {
    const value = factories._onUnsubscribe ?? onUnsubscribePrimitive;
    bound.onUnsubscribe = ((handler: UnsubscribeHandler<any>) => {
      return (value as (inner: UnsubscribeHandler<any>) => unknown)(handler);
    }) as BoundOnUnsubscribeFactory<TName, TFactories>;
  }

  return bound as BoundServer<TName, TFactories>;
}
