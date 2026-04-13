/* oxlint-disable @typescript-eslint/no-explicit-any */
import { incoming as createIncoming } from '~/incoming/incoming.ts';
import { outgoing as createOutgoing } from '~/outgoing/outgoing.ts';
import type {
  ClientContractState,
  FoldablePrimitive,
  HandlerCtxFromState,
  MergeRecords,
  NextState,
  NoOutgoing,
  ScopeState,
  ScopeStateShape,
} from '~/_types/scope-state.ts';
import type { ChannelPrimitive } from '~/channel/channel.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { EventContract } from '~/event.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { NamespacePrimitive } from '~/namespace/namespace.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { validateBuild } from './validate.ts';

/**
 * Build the final `ServerContract` type from the accumulated builder state.
 *
 * Flattens the error definitions into a plain `{ code: detail }` map and
 * attaches the contract fields gathered during the builder chain. Channels
 * and namespaces are accumulated by their respective callback-form calls and
 * read from `contract.channels` / `contract.namespaces`.
 */
type ContractFromState<TState extends ScopeStateShape> = {
  readonly incoming: TState['contract']['incoming'];
  readonly outgoing: TState['contract']['outgoing'];
  readonly requests: TState['contract']['requests'];
  readonly streams: TState['contract']['streams'];
  readonly errors: ErrorMapFromDefs<TState['errors']>;
  readonly channels: TState['contract']['channels'];
  readonly namespaces: TState['contract']['namespaces'];
};

/**
 * Convert a tuple of `ErrorDef` values into a `{ code: detailType }` record.
 *
 * Uses a mapped type over the union of all tuple members. The `as` clause
 * remaps each union member's code string as the key, and the conditional type
 * extracts the matching detail type as the value.
 */
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
  never,
  TEnv
>;

/** The builder state after one `.outgoing()` call. */
type StateAfterOutgoing<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, OutgoingPrimitive<TEvent, TPayload>>;

/**
 * Merge a scope contract (from an extracted channel or namespace) into the
 * parent state's contract under a specific key (`channels` or `namespaces`).
 */
type MergeScopeContract<
  TState extends ScopeStateShape,
  TField extends 'channels' | 'namespaces',
  TName extends string,
  TContract,
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
  readonly scheduledTaskIds: TState['scheduledTaskIds'];
  readonly env: TState['env'];
};

/**
 * Merge a group's accumulated contract into the parent state.
 */
type MergeGroupContract<
  TState extends ScopeStateShape,
  TGroupContract extends ClientContractState,
> = {
  readonly kind: TState['kind'];
  readonly outgoing: TState['outgoing'];
  readonly hasAck: TState['hasAck'];
  readonly hasReplay: TState['hasReplay'];
  readonly contract: {
    incoming: MergeRecords<TState['contract']['incoming'], TGroupContract['incoming']>;
    outgoing: MergeRecords<TState['contract']['outgoing'], TGroupContract['outgoing']>;
    requests: MergeRecords<TState['contract']['requests'], TGroupContract['requests']>;
    streams: MergeRecords<TState['contract']['streams'], TGroupContract['streams']>;
    channels: MergeRecords<TState['contract']['channels'], TGroupContract['channels']>;
    namespaces: MergeRecords<TState['contract']['namespaces'], TGroupContract['namespaces']>;
  };
  readonly errors: TState['errors'];
  readonly meta: TState['meta'];
  readonly channelNames: TState['channelNames'];
  readonly scheduledTaskIds: TState['scheduledTaskIds'];
  readonly env: TState['env'];
};

/**
 * Compute the builder state after `.use(primitive)`.
 */
type UseResult<TState extends ScopeStateShape, P extends Primitive> =
  P extends GroupPrimitive<infer TGroupState extends ScopeStateShape>
    ? MergeGroupContract<TState, TGroupState['contract']>
    : P extends ChannelPrimitive<any, any, infer TName extends string, infer TContract>
      ? MergeScopeContract<TState, 'channels', TName, TContract>
      : P extends NamespacePrimitive<any, any, infer TName extends string, infer TContract>
        ? MergeScopeContract<TState, 'namespaces', TName, TContract>
        : P extends FoldablePrimitive
          ? NextState<TState, P>
          : TState;

/** The builder state after one `.incoming()` call. */
type StateAfterIncoming<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, IncomingPrimitive<TEvent, TPayload, any>>;

/**
 * The fluent builder used to define a wskit WebSocket server.
 *
 * Every method returns a new `ServerBuilder` (with an updated type state) so
 * calls can be chained. The type parameter `TState` tracks what has been
 * registered so far — it controls which events `ctx.send()` accepts and
 * whether optional features like `ctx.ack()` are available.
 *
 * Built-in methods are always available. Extra methods (`.ack()`,
 * `.onConnect()`, `.channel()`, etc.) are added by side-effect imports:
 *
 * ```typescript
 * import '@wskit/server/ack'
 * import '@wskit/server/lifecycle'
 * ```
 *
 * **Typical usage**
 * ```typescript
 * const chat = server('chat')
 *   .outgoing(message)
 *   .incoming(sendMessage, async (ctx, payload) => {
 *     ctx.broadcast('message', { text: payload.text, from: ctx.meta.userId })
 *   })
 *   .build()
 * ```
 *
 * @template TState - Accumulated builder state. Do not pass this manually;
 *   TypeScript infers it through the chain.
 */
export class ServerBuilder<TState extends ScopeStateShape = InitialState> {
  /** @internal Collected primitive instances, populated by each builder method. */
  readonly _primitives: Primitive[] = [];
  /** @internal The server name passed to `server(name)`. */
  readonly _name: string;

  constructor(name: string) {
    this._name = name;
  }

  /**
   * Declare an event that the server can send to clients.
   *
   * This registers the event in the client contract so `InferClient` exposes
   * it on the typed client. Inside handlers, calling `ctx.send('event-name',
   * payload)` is only allowed for events declared with `.outgoing()`.
   *
   * @example
   * ```typescript
   * const message = event('message', v.object({ text: v.string() }))
   *
   * server('chat')
   *   .outgoing(message)
   *   .incoming(sendMessage, async (ctx, payload) => {
   *     ctx.send('message', { text: payload.text }) // typed and safe
   *   })
   * ```
   */
  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): ServerBuilder<StateAfterOutgoing<TState, TEvent, TPayload>> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  /**
   * Register a handler for an event sent by the client.
   *
   * The `handler` is called every time a connected client sends a message
   * matching `eventContract.event`. The payload is validated against the
   * event's schema before your handler receives it.
   *
   * The `ctx` argument gives access to `ctx.send()`, `ctx.broadcast()`,
   * `ctx.meta`, and any extra methods enabled by registered primitives
   * (e.g. `ctx.ack()` when `.ack()` is registered).
   *
   * @example
   * ```typescript
   * server('chat')
   *   .incoming(sendMessage, async (ctx, payload) => {
   *     // payload: { text: string } — validated and typed
   *     ctx.broadcast('message', { text: payload.text, from: ctx.meta.userId })
   *   })
   * ```
   */
  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): ServerBuilder<StateAfterIncoming<TState, TEvent, TPayload>> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  /**
   * Plug a primitive, module, or extracted scope into this builder.
   *
   * Groups, channels, and namespaces created with the callback form on `base`
   * return primitives that go through `.use()`:
   *
   * @example
   * ```typescript
   * import { chatChannel } from './chat/channel'
   * import { Analytics } from '@wskit/analytics'
   *
   * server('shop')
   *   .use(Analytics({ sampleRate: 0.5 }))
   *   .use(chatChannel)
   *   .build()
   * ```
   */
  use<P extends Primitive>(primitive: P): ServerBuilder<UseResult<TState, P>> {
    if (primitive.__wskit === 'group') {
      this._primitives.push(...(primitive as unknown as GroupPrimitive).primitives);
    } else {
      this._primitives.push(primitive);
    }
    return this as any;
  }

  /**
   * Create a group of flat primitives using a callback.
   *
   * Returns a `GroupPrimitive` that can be passed to `.use()` or assigned
   * to a variable for multi-file composition. Types flow from the parent
   * builder through the callback.
   *
   * @example Inline
   * ```typescript
   * server('shop')
   *   .use(base.group((g) => g.incoming(placeOrder, handler)))
   *   .build()
   * ```
   *
   * @example Multi-file
   * ```typescript
   * // order-handlers.ts
   * export const orderHandlers = base.group((g) => g
   *   .incoming(placeOrder, handler)
   * )
   *
   * // handler.ts
   * base.use(orderHandlers).build()
   * ```
   */
  group<TGroupState extends ScopeStateShape>(
    callback: (builder: GroupBuilder<TState>) => GroupBuilder<TGroupState>,
  ): GroupPrimitive<TGroupState> {
    const builder = new GroupBuilder<TState>(this);
    callback(builder);
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
   * Finalize the builder and produce a frozen `ServerDefinition`.
   *
   * This is the last call in every top-level server chain. It runs build-time
   * validation (duplicate events, missing dependencies) and returns an
   * immutable blueprint that adapters like `server-cloudflare` and `server-bun`
   * accept.
   *
   * @throws {Error} If any event is registered more than once, or if a
   *   primitive declares a dependency on another primitive that was not
   *   registered.
   *
   * @example
   * ```typescript
   * const chat = server('chat')
   *   .outgoing(message)
   *   .incoming(sendMessage, handler)
   *   .build() // → ServerDefinition
   *
   * export default chat
   * export type ChatSocket = InferClient<typeof chat>
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
 * Obtained via the callback in `.group((g) => g.incoming(...))`. Supports the
 * same `.outgoing()`, `.incoming()`, and `.use()` methods as `ServerBuilder`.
 *
 * @template TState - Inherited from the parent `ServerBuilder`. Controls which
 *   events are sendable in handler ctx.
 */
export class GroupBuilder<TState extends ScopeStateShape> {
  /** @internal Primitives accumulated while chaining builder methods. */
  readonly _primitives: Primitive[] = [];
  /** @internal The `ServerBuilder` that created this group. */
  readonly _parent: ServerBuilder<TState>;

  constructor(parent: ServerBuilder<TState>) {
    this._parent = parent;
  }

  /**
   * Declare an outgoing event inside this group.
   *
   * Works exactly like `ServerBuilder.outgoing()`.
   */
  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): GroupBuilder<StateAfterOutgoing<TState, TEvent, TPayload>> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  /**
   * Register an incoming event handler inside this group.
   *
   * Works exactly like `ServerBuilder.incoming()`.
   */
  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): GroupBuilder<StateAfterIncoming<TState, TEvent, TPayload>> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  /**
   * Plug a primitive or module into this group. Groups cannot be nested.
   */
  use<P extends Primitive>(
    primitive: P extends { __wskit: 'group' } ? never : P,
  ): GroupBuilder<UseResult<TState, P>> {
    this._primitives.push(primitive);
    return this as any;
  }
}

/**
 * A container primitive produced by `.group(callback)`.
 *
 * Passed to `ServerBuilder.use()`, which unwraps the inner primitives flat.
 *
 * @template _TState - Phantom type carrying the accumulated builder state.
 */
export interface GroupPrimitive<
  _TState extends ScopeStateShape = ScopeStateShape,
> extends Primitive<'group'> {
  readonly primitives: readonly Primitive[];
}

/**
 * Create a new `ServerBuilder` to start defining a wskit WebSocket server.
 *
 * `name` identifies the server for logging, error messages, and debugging.
 * It does not affect the wire protocol.
 *
 * Chain builder methods to register events, handlers, and features, then
 * call `.build()` to get the final `ServerDefinition`:
 *
 * ```typescript
 * import { server, event } from '@wskit/server'
 * import '@wskit/server/lifecycle'
 * import * as v from 'valibot'
 *
 * const message = event('message', v.object({ text: v.string() }))
 * const sendMessage = event('send-message', v.object({ text: v.string() }))
 *
 * export const chat = server('chat')
 *   .outgoing(message)
 *   .incoming(sendMessage, async (ctx, payload) => {
 *     ctx.broadcast('message', { text: payload.text, from: ctx.meta.userId })
 *   })
 *   .onConnect((ctx) => {
 *     console.log('connected:', ctx.id)
 *   })
 *   .build()
 *
 * export type ChatSocket = InferClient<typeof chat>
 * ```
 */
export function server<TEnv extends object = Record<string, unknown>>(
  name: string,
): ServerBuilder<InitialState<TEnv>> {
  return new ServerBuilder(name) as ServerBuilder<InitialState<TEnv>>;
}
