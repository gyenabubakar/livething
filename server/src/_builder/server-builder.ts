/* oxlint-disable @typescript-eslint/no-explicit-any */
import { incoming as createIncoming } from '~/incoming/incoming.ts';
import { outgoing as createOutgoing } from '~/outgoing/outgoing.ts';
import type {
  FeatureApplicator,
  GroupBuilderFull,
  ServerBuilderFull,
} from '~/_types/feature-methods.ts';
import type {
  FoldablePrimitive,
  HandlerCtxFromState,
  MergeRecords,
  NextState,
  NoOutgoing,
  ScopeState,
  ScopeStateShape,
} from '~/_types/scope-state';
import type { ChannelPattern, ChannelPrimitive, ScopeDeclaration } from '~/channel/channel.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { EventContract } from '~/event.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { NamespacePrimitive } from '~/namespace/namespace.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { validateBuild } from './validate.ts';

type ContractFromState<TState extends ScopeStateShape> = {
  readonly incoming: TState['contract']['incoming'];
  readonly outgoing: TState['contract']['outgoing'];
  readonly requests: TState['contract']['requests'];
  readonly streams: TState['contract']['streams'];
  readonly errors: ErrorMapFromDefs<TState['errors']>;
  readonly channels: TState['contract']['channels'];
  readonly namespaces: TState['contract']['namespaces'];
};

type ErrorMapFromDefs<TDefs extends readonly ErrorDef<string, any>[]> = {
  [TDef in TDefs[number] as TDef extends ErrorDef<infer TCode, any>
    ? TCode
    : never]: TDef extends ErrorDef<string, infer TDetail> ? TDetail : never;
};

/** The blank-slate state every new `ServerBuilder` starts from. */
type InitialState<TEnv extends object = Record<string, unknown>> = ScopeState<
  'top',
  NoOutgoing,
  false,
  false,
  { incoming: {}; outgoing: {}; requests: {}; streams: {}; channels: {}; namespaces: {} },
  readonly [],
  Record<string, unknown>,
  never,
  {},
  TEnv,
  never,
  never,
  {}
>;

type StateAfterOutgoing<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, OutgoingPrimitive<TEvent, TPayload>>;

type ServerBuilderAfterOutgoing<
  TState extends ScopeStateShape,
  TFeatures,
  TEvent extends string,
  TPayload,
> = ServerBuilderFull<StateAfterOutgoing<TState, TEvent, TPayload>, TFeatures>;

type GroupBuilderAfterOutgoing<
  TState extends ScopeStateShape,
  TFeatures,
  TEvent extends string,
  TPayload,
> = GroupBuilderFull<StateAfterOutgoing<TState, TEvent, TPayload>, TFeatures>;

/**
 * Folds a single newly-declared channel or namespace into the running
 * `TState['contract']`. Used by `UseResult` for `.use(channel(...))` and
 * `.use(namespace(...))`. Sibling of `MergeGroupContract` — both follow the
 * same template (preserve all state fields, merge one contract slot); see the
 * other for shape.
 *
 * @internal
 */
/**
 * Pull the server→client event map out of a channel contract.
 *
 * In wskit's contract, `contract.incoming` is what the *client* receives
 * (i.e. events the server sends out), and `contract.outgoing` is what the
 * client sends. The handle's `send`/`broadcast` accept events from the
 * server-outgoing direction, so we read `incoming` from the contract here.
 */
type ChannelOutgoingFromContract<TContract> = TContract extends { incoming: infer O }
  ? O extends Record<string, any>
    ? O
    : {}
  : {};

type MergeScopeContract<
  TState extends ScopeStateShape,
  TField extends 'channels' | 'namespaces',
  TName extends string,
  TContract,
  TPattern extends ChannelPattern | undefined = undefined,
> = {
  readonly kind: TState['kind'];
  readonly outgoing: TState['outgoing'];
  readonly hasAck: TState['hasAck'];
  readonly hasReplay: TState['hasReplay'];
  readonly contract: {
    incoming: TState['contract']['incoming'];
    outgoing: TState['contract']['outgoing'];
    requests: TState['contract']['requests'];
    streams: TState['contract']['streams'];
    channels: TField extends 'channels'
      ? MergeRecords<TState['contract']['channels'], Record<TName, TContract>>
      : TState['contract']['channels'];
    namespaces: TField extends 'namespaces'
      ? MergeRecords<TState['contract']['namespaces'], Record<TName, TContract>>
      : TState['contract']['namespaces'];
  };
  readonly errors: TState['errors'];
  readonly meta: TState['meta'];
  readonly channelNames: TField extends 'channels'
    ? TState['channelNames'] | TName
    : TState['channelNames'];
  readonly staticChannelNames: TField extends 'channels'
    ? TPattern extends ScopeDeclaration<any>
      ? TState['staticChannelNames']
      : TPattern extends string
        ? TState['staticChannelNames'] | TPattern
        : TState['staticChannelNames']
    : TState['staticChannelNames'];
  readonly channelFamilyKeys: TField extends 'channels'
    ? TPattern extends ScopeDeclaration<infer K extends string>
      ? TState['channelFamilyKeys'] | K
      : TState['channelFamilyKeys']
    : TState['channelFamilyKeys'];
  readonly channelOutgoingByKey: TField extends 'channels'
    ? TPattern extends ScopeDeclaration<infer K extends string>
      ? MergeRecords<
          TState['channelOutgoingByKey'],
          Record<K, ChannelOutgoingFromContract<TContract>>
        >
      : TPattern extends string
        ? MergeRecords<
            TState['channelOutgoingByKey'],
            Record<TPattern, ChannelOutgoingFromContract<TContract>>
          >
        : TState['channelOutgoingByKey']
    : TState['channelOutgoingByKey'];
  readonly scheduledTasks: TState['scheduledTasks'];
  readonly env: TState['env'];
};

/**
 * Folds an entire group's contract (every field) into the running
 * `TState['contract']`. Used by `UseResult` for `.use(group(...))`. Sibling of
 * `MergeScopeContract` — both follow the same template (preserve all state
 * fields, merge contract slots); see the other for shape.
 *
 * @internal
 */
type MergeGroupContract<TState extends ScopeStateShape, TGroupState extends ScopeStateShape> = {
  readonly kind: TState['kind'];
  readonly outgoing: TState['outgoing'];
  readonly hasAck: TState['hasAck'];
  readonly hasReplay: TState['hasReplay'];
  readonly contract: {
    incoming: MergeRecords<TState['contract']['incoming'], TGroupState['contract']['incoming']>;
    outgoing: MergeRecords<TState['contract']['outgoing'], TGroupState['contract']['outgoing']>;
    requests: MergeRecords<TState['contract']['requests'], TGroupState['contract']['requests']>;
    streams: MergeRecords<TState['contract']['streams'], TGroupState['contract']['streams']>;
    channels: MergeRecords<TState['contract']['channels'], TGroupState['contract']['channels']>;
    namespaces: MergeRecords<
      TState['contract']['namespaces'],
      TGroupState['contract']['namespaces']
    >;
  };
  readonly errors: TState['errors'];
  readonly meta: TState['meta'];
  readonly channelNames: TState['channelNames'] | TGroupState['channelNames'];
  readonly staticChannelNames: TState['staticChannelNames'] | TGroupState['staticChannelNames'];
  readonly channelFamilyKeys: TState['channelFamilyKeys'] | TGroupState['channelFamilyKeys'];
  readonly channelOutgoingByKey: MergeRecords<
    TState['channelOutgoingByKey'],
    TGroupState['channelOutgoingByKey']
  >;
  readonly scheduledTasks: MergeRecords<TState['scheduledTasks'], TGroupState['scheduledTasks']>;
  readonly env: TState['env'];
};

/**
 * Computes the new `TState` produced by `.use(primitive)`. Dispatches on the
 * primitive kind: groups merge full contracts, channels and namespaces add
 * one named entry, foldable primitives advance the state, anything else
 * leaves the state untouched.
 *
 * @internal
 */
type UseResult<TState extends ScopeStateShape, P extends Primitive> =
  P extends GroupPrimitive<infer TGroupState extends ScopeStateShape>
    ? MergeGroupContract<TState, TGroupState>
    : P extends ChannelPrimitive<
          infer TPattern extends ChannelPattern,
          any,
          infer TName extends string,
          infer TContract
        >
      ? MergeScopeContract<TState, 'channels', TName, TContract, TPattern>
      : P extends NamespacePrimitive<any, any, infer TName extends string, infer TContract>
        ? MergeScopeContract<TState, 'namespaces', TName, TContract>
        : P extends FoldablePrimitive
          ? NextState<TState, P>
          : TState;

type StateAfterIncoming<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, IncomingPrimitive<TEvent, TPayload, any>>;

/**
 * The fluent builder used to define a wskit WebSocket server.
 *
 * As you chain builder calls, the builder remembers what has been declared
 * so far — outgoing events, requests, replay support, handler context fields —
 * and uses that to type later calls.
 *
 * Feature methods like `.ack()` and `.onConnect()` are attached by the `with*`
 * helpers, so you always work with the full fluent builder type rather than
 * this class on its own.
 *
 * @template TState - What the builder has declared so far.
 * @template TFeatures - Which optional feature families are enabled.
 */
export class ServerBuilder<TState extends ScopeStateShape = InitialState, TFeatures = {}> {
  readonly _primitives: Primitive[] = [];
  readonly _name: string;
  readonly _featureApplicators: FeatureApplicator[] = [];

  constructor(name: string) {
    this._name = name;
  }

  /**
   * Declare an event the server is allowed to send to clients.
   *
   * Pass an {@link EventContract} created with `event()`. The event name and
   * payload type flow into the client's generated types via {@link InferClient}.
   *
   * @example
   * ```ts
   * import { server, event } from '@wskit/server';
   * import * as v from 'valibot';
   *
   * const Greeting = event('greeting', v.object({ text: v.string() }));
   *
   * server('app').outgoing(Greeting);
   * ```
   */
  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): ServerBuilderAfterOutgoing<TState, TFeatures, TEvent, TPayload> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  /**
   * Declare an event the server can receive from clients and attach a handler.
   *
   * The handler runs once per incoming message after the event contract's
   * validator accepts the payload. Throw {@link ValidationFailed} from inside
   * the handler to reject a message after a custom check — always call it as
   * a constructor: `throw ValidationFailed({ event: 'send-chat', issues: [{ message: '...' }] })`.
   *
   * @example
   * ```ts
   * import { server, event } from '@wskit/server';
   * import { ValidationFailed } from '@wskit/server/errors';
   * import * as v from 'valibot';
   *
   * const SendChat = event('send-chat', v.object({ text: v.string() }));
   *
   * server('app').incoming(SendChat, (ctx, payload) => {
   *   if (payload.text.includes('badword')) {
   *     throw ValidationFailed({
   *       event: 'send-chat',
   *       issues: [{ message: 'text contains a disallowed word' }],
   *     });
   *   }
   *   ctx.broadcast('chat-msg', { text: payload.text });
   * });
   * ```
   */
  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): ServerBuilderFull<StateAfterIncoming<TState, TEvent, TPayload>, TFeatures> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  /**
   * Attach a compiled primitive to this builder.
   *
   * Use this to mount a {@link channel}, {@link namespace}, module, or a group
   * of primitives returned by {@link ServerBuilder.group}. A group's
   * declarations are added to the current scope; channels and namespaces
   * become their own sub-scopes.
   *
   * @example
   * ```ts
   * const shared = base.group((g) => g.outgoing(Ping));
   * base.use(shared);
   * ```
   */
  use<P extends Primitive>(primitive: P): ServerBuilderFull<UseResult<TState, P>, TFeatures> {
    if (primitive.__wskit === 'group') {
      this._primitives.push(...(primitive as unknown as GroupPrimitive).primitives);
    } else {
      this._primitives.push(primitive);
    }
    return this as any;
  }

  /**
   * Define a reusable group of flat primitives that can be `.use()`-d later.
   *
   * Groups cannot be nested inside each other and cannot contain channels or
   * namespaces — use them to share sets of `incoming` and `outgoing` declarations
   * between multiple builders.
   *
   * @example
   * ```ts
   * const pingPong = base.group((g) =>
   *   g.outgoing(Pong).incoming(Ping, (ctx) => ctx.send('pong', {})),
   * );
   *
   * base.use(pingPong);
   * ```
   */
  group<TGroupState extends ScopeStateShape>(
    callback: (
      builder: GroupBuilderFull<TState, TFeatures>,
    ) => GroupBuilderFull<TGroupState, TFeatures>,
  ): GroupPrimitive<TGroupState> {
    const builder = new GroupBuilder<TState, TFeatures>(this);
    for (const applicator of this._featureApplicators) {
      applicator(builder, 'group');
    }
    callback(builder as any);
    return {
      __wskit: 'group' as const,
      __kind: 'scope' as const,
      __identity: [Symbol('group')] as const,
      __dependencies: [],
      __requires: {},
      primitives: [...builder._primitives],
    } as GroupPrimitive<TGroupState>;
  }

  /**
   * Finalize the builder into an immutable {@link ServerDefinition}.
   *
   * Pass the returned value to an adapter's `serve()` function (for example
   * `serve(handler)` from `@wskit/server-cloudflare`). Throws if any build-time
   * invariant fails — for example, duplicate event names or missing
   * dependencies between primitives.
   *
   * @example
   * ```ts
   * import { serve } from '@wskit/server-cloudflare';
   *
   * const handler = server('app').outgoing(Greeting).build();
   * export const Room = serve(handler);
   * ```
   */
  build(): ServerDefinition<readonly Primitive[], ContractFromState<TState>> {
    validateBuild(this._primitives);
    return Object.freeze({
      __wskit: 'server' as const,
      primitives: Object.freeze([...this._primitives]) as readonly Primitive[],
    });
  }
}

/**
 * A sub-builder for collecting a reusable set of flat primitives.
 *
 * @template TState - Inherited from the parent `ServerBuilder`.
 * @template TFeatures - Feature flags inherited from the parent.
 */
export class GroupBuilder<TState extends ScopeStateShape, TFeatures = {}> {
  readonly _primitives: Primitive[] = [];
  readonly _featureApplicators: FeatureApplicator[] = [];
  readonly _parent: ServerBuilder<TState, TFeatures>;

  constructor(parent: ServerBuilder<TState, TFeatures>) {
    this._parent = parent;
  }

  /**
   * Declare an event this group is allowed to send to clients.
   *
   * Pass an {@link EventContract} created with `event()`. The event name and
   * payload type flow into any builder that `.use()`s this group, so handlers
   * mounted after the group can call `ctx.send(...)` or `ctx.broadcast(...)`
   * with the event safely typed.
   *
   * @example
   * ```ts
   * import { event, server } from '@wskit/server';
   * import * as v from 'valibot';
   *
   * const Pong = event('pong', v.object({ at: v.number() }));
   *
   * const base = server('app');
   * const pingPong = base.group((g) => g.outgoing(Pong));
   * ```
   */
  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): GroupBuilderAfterOutgoing<TState, TFeatures, TEvent, TPayload> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  /**
   * Declare an event this group can receive from clients and attach a handler.
   *
   * The handler runs only after the event contract's validator accepts the
   * payload. Its `ctx` type includes everything declared earlier in the group
   * and in the parent builder, so shared group handlers keep the same typed
   * `send`, `broadcast`, tags, scheduling, and context helpers as normal
   * handlers.
   *
   * @example
   * ```ts
   * const Ping = event('ping', v.object({}));
   * const Pong = event('pong', v.object({ at: v.number() }));
   *
   * const pingPong = base.group((g) =>
   *   g.outgoing(Pong).incoming(Ping, (ctx) => {
   *     ctx.send('pong', { at: Date.now() });
   *   }),
   * );
   * ```
   */
  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): GroupBuilderFull<StateAfterIncoming<TState, TEvent, TPayload>, TFeatures> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  /**
   * Attach a compiled primitive to this group.
   *
   * Use this for channels, namespaces, modules, or other feature primitives
   * that should travel with the group. Groups cannot contain other groups; if
   * you need several shared bundles, mount them separately on the parent
   * builder.
   */
  use<P extends Primitive>(
    primitive: P extends { __wskit: 'group' } ? never : P,
  ): GroupBuilderFull<UseResult<TState, P>, TFeatures> {
    this._primitives.push(primitive);
    return this as any;
  }
}

/**
 * A compiled group of primitives produced by `ServerBuilder.group()`.
 *
 * A group is a portable bundle of flat primitives (`incoming`, `outgoing`,
 * etc.) you can mount onto any builder with `.use()`. Use it to share common
 * declarations between multiple servers without duplicating code.
 *
 * @example
 * ```ts
 * import { server, event } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const Ping = event('ping', v.object({}));
 *
 * // .group(...) returns a GroupPrimitive...
 * const shared = server('app').group((g) =>
 *   g.incoming(Ping, (ctx) => ctx.send('pong', {})),
 * );
 *
 * // ...and .use(...) registers its declarations in the current scope.
 * server('app').use(shared);
 * ```
 */
export interface GroupPrimitive<
  _TState extends ScopeStateShape = ScopeStateShape,
> extends Primitive<'group'> {
  readonly primitives: readonly Primitive[];
}

/**
 * Create a new wskit server builder.
 *
 * This is the starting point for defining your WebSocket server. Chain
 * `.outgoing()`, `.incoming()`, and feature methods to describe what your
 * server can do, then call `.build()` to produce a compiled definition.
 *
 * By itself, the base builder only supports `.outgoing()`, `.incoming()`,
 * `.use()`, `.group()`, and `.build()`. Wrap it with `with*` functions
 * (or use the batteries-included `server` from `@wskit/server/full`) to
 * unlock features like channels, lifecycle hooks, and streams.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 * import { withLifecycle } from '@wskit/server/lifecycle';
 *
 * const handler = withLifecycle(server('my-app'))
 *   .outgoing(Greeting)
 *   .incoming(SendChat, (ctx, payload) => {
 *     ctx.broadcast('greeting', { text: payload.text });
 *   })
 *   .build();
 * ```
 */
export function server<TEnv extends object = Record<string, unknown>>(
  name: string,
): ServerBuilderFull<InitialState<TEnv>, {}> {
  return new ServerBuilder(name) as ServerBuilderFull<InitialState<TEnv>, {}>;
}
