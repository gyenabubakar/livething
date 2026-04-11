/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
  BeforeSubscribeHandler,
  BeforeSubscribePrimitive,
  ChannelPattern,
  ChannelPrimitive,
  SubscribeHandler,
  SubscribePrimitive,
  UnsubscribeHandler,
  UnsubscribePrimitive,
} from '../channel/index.ts';
import type { defineServer } from '../define-server.ts';
import type { IncomingHandler, IncomingPrimitive } from '../incoming/index.ts';
import type {
  PostInterceptHandler,
  PostInterceptPrimitive,
  PreInterceptHandler,
  PreInterceptPrimitive,
} from '../intercept/index.ts';
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
} from '../lifecycle.ts';
import type { NamespacePrimitive } from '../namespace/index.ts';
import type { OutgoingPrimitive } from '../outgoing/index.ts';
import type { ReceivedEvent } from '../received.ts';
import type { ReplayPrimitive } from '../replay/index.ts';
import type { RequestHandler, RequestPrimitive } from '../request/index.ts';
import type { ScheduledHandler, ScheduledOptions, ScheduledPrimitive } from '../scheduled/index.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '../stream/index.ts';
import type { TypeMarker } from '../t.ts';
import type {
  BoundChannelContext,
  BoundInitContext,
  BoundNamespaceContext,
  BoundServerContext,
  BoundShutdownContext,
  BoundTaskContext,
  EventBoundIncomingContext,
  EventBoundPostInterceptContext,
  EventBoundRequestContext,
  EventName,
  EventPayload,
  ServerPrimitiveFactories,
} from './context-types.ts';

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

type StripUnderscore<TName extends string> = TName extends `_${infer TStripped}`
  ? TStripped
  : TName;

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

/**
 * A named server with pre-bound, context-aware primitive factories.
 *
 * Created by `server('my-server', { ... })`. The `define` method replaces
 * `defineServer` with auto-injected defaults based on the factory set.
 */
export type BoundServer<
  TName extends string,
  TFactories extends ServerPrimitiveFactories,
> = BoundPassthroughFactories<TName, TFactories> & {
  /** Call this instead of `defineServer` — it auto-injects infrastructure primitives. */
  readonly define: typeof defineServer;
  /** The server name used for registry lookups and code generation. */
  readonly name: TName;
};
