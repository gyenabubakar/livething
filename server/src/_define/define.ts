/* oxlint-disable @typescript-eslint/no-explicit-any */
import { hibernation as hibernationFactory } from '~/hibernation/hibernation.ts';
import { incoming as incomingFactory } from '~/incoming/incoming.ts';
import { intercept as interceptFactory } from '~/intercept/intercept.ts';
import {
  onConnect,
  onDisconnect,
  onError,
  onInit,
  onShutdown,
  onUpgrade,
  onValidationError,
} from '~/lifecycle/lifecycle.ts';
import { request as requestFactory } from '~/request/request.ts';
import { makeScheduledPrimitive } from '~/scheduled/scheduled.ts';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { InitContext, ShutdownContext, TaskContext } from '~/context.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { UpgradeHandler, UpgradeResult } from '~/lifecycle/lifecycle.ts';
import type { Primitive } from '~/primitive.ts';
import type { RateLimitCapability } from '~/rate-limit/capability.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';
import type { CustomReplayHooks, ReplayCustomCapability } from '~/replay/capability.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { ScheduledCapability, ScheduledDeclaration } from '~/scheduled/capability.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type { Validator } from '~/types.ts';
import type { AppCtx } from './app-ctx.ts';
import type {
  AnyCapability,
  BrandsOf,
  Contribution,
  MergeSlots,
  SlotOr,
  SlotsOf,
} from './capability.ts';
import type { BuildContract, InferInput } from './contract.ts';

/**
 * What an `upgrade(...)` function returns to accept a connection. Return an
 * `identity` (the stable per-user key) and optional `meta`. Throw
 * `RejectUpgrade(code, reason)` to refuse the handshake.
 */
export interface UpgradeReturn<TMeta> {
  /** Stable key for the user behind this socket — used as the row key for durable state. */
  readonly identity: string;
  /** Per-connection metadata, surfaced as `ctx.meta` in every handler. */
  readonly meta?: TMeta;
}

/** The `upgrade(...)` function shape. Receives the raw upgrade request. */
export type UpgradeFn<TMeta> = (
  request: Request,
) => UpgradeReturn<TMeta> | Promise<UpgradeReturn<TMeta>>;

/**
 * The configuration passed to `define(...)`. Holds only bootstrap — the things
 * the runtime needs to exist and accept a connection. Every feature beyond this
 * is an entry in `capabilities`.
 */
export interface DefineConfig<
  TEnv = unknown,
  TMeta = unknown,
  TCaps extends readonly AnyCapability[] = readonly AnyCapability[],
> {
  /** The platform env bindings type, marked with `t<Env>()`. */
  readonly env: TypeMarker<TEnv>;
  /** Auth gate. Return `{ identity, meta }` to accept, or throw `RejectUpgrade(...)` to deny. */
  readonly upgrade?: UpgradeFn<TMeta>;
  /** Turn on Cloudflare Durable Object hibernation (which disables server pings). */
  readonly hibernation?: { readonly enabled: boolean };
  /** The features this server uses. Listing one pulls its engine code into the bundle. */
  readonly capabilities?: TCaps;
}

/** The value `base.on(...)` returns — a handler primitive that also declares its contract slot. */
export type IncomingHandlerValue<TEvent extends string, TPayload> = IncomingPrimitive<
  TEvent,
  TPayload
> &
  Contribution<{ incoming: Record<TEvent, TPayload> }>;

/** Configuration object for `base.on(...)`. */
export interface OnConfig<TSlots, TEnv, TMeta, TSchema extends Validator | undefined> {
  /** Optional schema validating the incoming payload. Omit to accept any payload (typed `unknown`). */
  readonly input?: TSchema;
  /** Per-handler rate-limit override — tighten, loosen, or disable the limit for this event. */
  readonly rateLimit?: RateLimitConfig;
  /** Runs each time the client sends this event, with the validated payload. */
  run(ctx: AppCtx<TSlots, TEnv, TMeta>, input: InferInput<TSchema>): void | Promise<void>;
}

/** The value `base.request(...)` returns — a handler primitive that declares its request slot. */
export type RequestHandlerValue<TEvent extends string, TPayload, TResponse> = RequestPrimitive<
  TEvent,
  TPayload,
  TResponse
> &
  Contribution<{ requests: Record<TEvent, { payload: TPayload; response: TResponse }> }>;

/** Configuration object for `base.request(...)`. */
export interface RequestConfig<
  TSlots,
  TEnv,
  TMeta,
  TSchema extends Validator | undefined,
  TResponse,
> {
  /** Optional schema validating the request payload. Omit to accept any payload (typed `unknown`). */
  readonly input?: TSchema;
  /** Per-handler rate-limit override — tighten, loosen, or disable the limit for this request. */
  readonly rateLimit?: RateLimitConfig;
  /** Runs the request and returns the reply. The reply type is inferred from the return. */
  run(ctx: AppCtx<TSlots, TEnv, TMeta>, input: InferInput<TSchema>): TResponse | Promise<TResponse>;
}

/** Builder method granted by the `requests()` capability. */
export interface RequestMethods<TSlots, TEnv, TMeta> {
  /**
   * Register a handler for one client→server request. Like `base.on`, but the
   * client awaits a reply: whatever the handler returns becomes the response,
   * and its type is inferred from the return. Returning nothing rejects the
   * client's pending request.
   */
  request<
    TEvent extends string,
    TSchema extends Validator | undefined = undefined,
    TResponse = void,
  >(
    event: TEvent,
    config: RequestConfig<TSlots, TEnv, TMeta, TSchema, TResponse>,
  ): RequestHandlerValue<TEvent, InferInput<TSchema>, Awaited<TResponse>>;
}

/** The scheduled-task map (task id → payload type), read off the merged contract slots. */
type ScheduledMap<TSlots> = SlotOr<TSlots, 'scheduled'>;

/** The value `base.scheduled(...)` returns — a carrier matched to its declaration at assembly. */
export interface ScheduledHandlerValue<TTaskId extends string> extends Contribution<{}> {
  /** Marks this value as a scheduled-task body for `assemble(...)` to merge. @internal */
  readonly __wskitScheduledHandler: true;
  /** The task id this body runs. @internal */
  readonly taskId: TTaskId;
  /** The task body. @internal */
  readonly run: (ctx: TaskContext, data?: unknown) => void | Promise<void>;
}

/** Configuration object for `base.scheduled(...)`. */
export interface ScheduledConfig<TEnv, TMeta, TData> {
  /** Runs when the task fires. Receives the typed payload for tasks that declare one. */
  run: TData extends undefined
    ? (ctx: TaskContext<TEnv, TMeta>) => void | Promise<void>
    : (ctx: TaskContext<TEnv, TMeta>, data: TData) => void | Promise<void>;
}

/** Builder method granted by the `scheduled()` capability. */
export interface ScheduledMethods<TSlots, TEnv, TMeta> {
  /**
   * Register the body for one declared scheduled task. The task id and its
   * payload type come from the `scheduled(...)` capability; binding an
   * undeclared task is a type error.
   */
  scheduled<TTaskId extends keyof ScheduledMap<TSlots> & string>(
    taskId: TTaskId,
    config: ScheduledConfig<TEnv, TMeta, ScheduledMap<TSlots>[TTaskId]>,
  ): ScheduledHandlerValue<TTaskId>;
}

/** Builder method granted by the `replay.custom()` capability. */
export interface ReplayMethods {
  /**
   * Register a custom replay strategy: your own storage and resend. The
   * `replay` hook (the resend) is required; `beforeSend` / `afterSend` are
   * optional. One registration per server.
   */
  replay(hooks: CustomReplayHooks): void;
}

/**
 * The builder methods the listed capabilities grant `base`, selected by each
 * capability's brand. A capability with no brand grants nothing.
 */
export type CapabilityMethods<
  TSlots,
  TEnv,
  TMeta,
  TBrand extends string,
> = ('requests' extends TBrand ? RequestMethods<TSlots, TEnv, TMeta> : {}) &
  ('scheduled' extends TBrand ? ScheduledMethods<TSlots, TEnv, TMeta> : {}) &
  ('replay-custom' extends TBrand ? ReplayMethods : {});

/**
 * The builder returned by `define(...)`. Carries the methods every server has
 * (`on`, the lifecycle hooks, `intercept`, `assemble`) plus any methods the
 * listed capabilities grant through their brands.
 */
export type Base<TSlots, TEnv, TMeta, TCaps extends readonly AnyCapability[]> = CoreBase<
  TSlots,
  TEnv,
  TMeta
> &
  CapabilityMethods<TSlots, TEnv, TMeta, BrandsOf<TCaps>>;

/** The methods present on every `base`, whatever capabilities are listed. */
export interface CoreBase<TSlots, TEnv, TMeta> {
  /**
   * Register a handler for one client→server event. The handler is an
   * exportable value — pass it to `assemble(...)`. Exactly one handler per event
   * name is allowed across the whole server.
   */
  on<TEvent extends string, TSchema extends Validator | undefined = undefined>(
    event: TEvent,
    config: OnConfig<TSlots, TEnv, TMeta, TSchema>,
  ): IncomingHandlerValue<TEvent, InferInput<TSchema>>;

  /** Run once at server startup, before any connection. Use it for schema creation or migrations. */
  init(handler: (ctx: InitContext) => void | Promise<void>): void;
  /** Run each time a connection opens, after `upgrade(...)` succeeds. */
  connect(handler: (ctx: AppCtx<TSlots, TEnv, TMeta>) => void | Promise<void>): void;
  /** Run each time a connection closes, for any reason. `ctx.closeCode` / `ctx.closeReason` are set. */
  disconnect(handler: (ctx: AppCtx<TSlots, TEnv, TMeta>) => void | Promise<void>): void;
  /** Run on any unhandled error from a handler. `event` is set when the error came from one. */
  error(
    handler: (
      ctx: AppCtx<TSlots, TEnv, TMeta>,
      error: unknown,
      event?: string,
    ) => void | Promise<void>,
  ): void;
  /** Run when an incoming payload fails its schema validation. */
  validationError(
    handler: (
      ctx: AppCtx<TSlots, TEnv, TMeta>,
      event: string,
      error: unknown,
    ) => void | Promise<void>,
  ): void;
  /** Run once when the server is shutting down. `ctx` is a server-wide context, with no single connection. */
  shutdown(handler: (ctx: ShutdownContext) => void | Promise<void>): void;
  /**
   * Inspect every incoming frame before routing and validation. Throw to reject;
   * return a value to replace the payload. One intercept per server.
   */
  intercept(
    handler: (ctx: AppCtx<TSlots, TEnv, TMeta>, frame: InterceptFrame) => unknown | void,
  ): void;

  /**
   * Collect every handler into the final server the platform adapter runs.
   * Pass each `base.on(...)` (and, with their capabilities, `request` / `stream`
   * / `channel` / `scheduled`) value. The upgrade hook, the lifecycle hooks, the
   * intercept, and the listed capabilities are folded in automatically.
   *
   * Capabilities belong in `define({ capabilities: [...] })`, not here — passing
   * one is a type error.
   */
  assemble<const THandlers extends readonly AssembleInput[]>(
    ...handlers: THandlers
  ): ServerDefinition<
    readonly Primitive[],
    BuildContract<MergeSlots<TSlots | SlotsOf<THandlers[number]>>>
  >;
}

/** A value `assemble(...)` accepts — a handler, never a capability. */
export type AssembleInput = Contribution & { readonly __wskitCapability?: never };

function isScheduledCarrier(value: Contribution): value is ScheduledHandlerValue<string> {
  return (value as { __wskitScheduledHandler?: unknown }).__wskitScheduledHandler === true;
}

/**
 * The primitive kinds that route by event name. An event name can belong to at
 * most one of these across a scope, so two of them sharing a name collide.
 */
const ROUTING_KINDS = new Set([
  'incoming',
  'request',
  'stream-generate',
  'resumable-stream-generate',
  'recorded-stream-generate',
]);

/**
 * Refuse two handlers that bind the same event. Compile catches this at engine
 * boot too, but catching it here gives a clearer, earlier build error (§21) —
 * including a collision across different kinds (for example `base.on('x')` and
 * `base.request('x')`), which the per-kind identity check alone would miss.
 */
function assertUniqueHandlers(handlers: readonly Primitive[]): void {
  const seen = new Map<symbol, Set<string>>();
  const routedEvents = new Map<string, string>();
  for (const handler of handlers) {
    const [key, registrationId] = handler.__identity;
    let registered = seen.get(key);
    if (!registered) {
      registered = new Set();
      seen.set(key, registered);
    }
    const id = registrationId ?? '';
    if (registered.has(id)) {
      throw new Error(
        `[wskit] Duplicate ${handler.__wskit} handler` +
          `${registrationId ? ` for '${registrationId}'` : ''} passed to assemble(). ` +
          'An event can only be bound once — drop the duplicate.',
      );
    }
    registered.add(id);

    if (ROUTING_KINDS.has(handler.__wskit)) {
      const event = (handler as { event?: string }).event;
      if (event !== undefined) {
        const owner = routedEvents.get(event);
        if (owner !== undefined && owner !== handler.__wskit) {
          throw new Error(
            `[wskit] Event name '${event}' is bound by both a ${owner} handler and a ` +
              `${handler.__wskit} handler passed to assemble(). An event name can only be one ` +
              'kind within a scope — pick a different name.',
          );
        }
        routedEvents.set(event, handler.__wskit);
      }
    }
  }
}

/**
 * Pair every declared scheduled task with its body and build the task
 * primitives. A declared task with no body, or a body with no declaration, is a
 * build error (§21).
 */
function mergeScheduled(
  declarations: ReadonlyMap<string, ScheduledDeclaration>,
  bodies: ReadonlyMap<string, (ctx: TaskContext, data?: unknown) => void | Promise<void>>,
): Primitive[] {
  const primitives: Primitive[] = [];
  for (const [taskId, declaration] of declarations) {
    const body = bodies.get(taskId);
    if (!body) {
      throw new Error(
        `[wskit] No handler for scheduled task '${taskId}'. ` +
          `Add base.scheduled('${taskId}', ...) and pass it to assemble().`,
      );
    }
    primitives.push(makeScheduledPrimitive(taskId, declaration, body));
  }
  for (const taskId of bodies.keys()) {
    if (!declarations.has(taskId)) {
      throw new Error(
        `[wskit] base.scheduled('${taskId}') has no matching declaration. ` +
          `Declare it in the scheduled({ ... }) capability.`,
      );
    }
  }
  return primitives;
}

/** Wrap a bootstrap `upgrade(...)` function as the engine's builder upgrade hook. */
function adaptUpgrade(fn: UpgradeFn<any>): UpgradeHandler {
  return async (request: Request): Promise<UpgradeResult> => {
    const result = await fn(request);
    return { identity: result.identity, meta: result.meta };
  };
}

/**
 * Create a WSKit server. `define(...)` holds only bootstrap (`env`, `upgrade`,
 * `hibernation`); every feature is a capability you list. It returns a `base`
 * builder whose methods are typed against your env, metadata, and capabilities.
 *
 * ```ts
 * import { define, emits, t } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const base = define({
 *   env: t<Env>(),
 *   async upgrade(request) {
 *     const username = new URL(request.url).searchParams.get('username');
 *     if (!username) throw RejectUpgrade(4001, 'Missing username');
 *     return { identity: username, meta: { username } };
 *   },
 *   capabilities: [emits({ welcome: t<{ username: string }>() })],
 * });
 *
 * export const handlePing = base.on('ping', {
 *   input: v.object({ text: v.string() }),
 *   run(ctx, input) { ctx.send('welcome', { username: input.text }); },
 * });
 *
 * export const handler = base.assemble(handlePing);
 * ```
 */
export function define<
  TEnv = unknown,
  TMeta = unknown,
  const TCaps extends readonly AnyCapability[] = readonly [],
>(
  config: DefineConfig<TEnv, TMeta, TCaps>,
): Base<MergeSlots<SlotsOf<TCaps[number]>>, TEnv, TMeta, TCaps> {
  const lifecyclePrimitives: Primitive[] = [];
  const seen = new Set<string>();

  function registerOnce(slot: string, primitive: Primitive): void {
    if (seen.has(slot)) {
      throw new Error(
        `[wskit] Duplicate ${slot} hook on this server. Only one ${slot} hook can be attached.`,
      );
    }
    seen.add(slot);
    lifecyclePrimitives.push(primitive);
  }

  const base = {
    on(event: string, config: OnConfig<any, any, any, any>) {
      const primitive = incomingFactory(
        event,
        config.run as any,
        config.input ? { validator: config.input } : undefined,
      );
      if (config.rateLimit) {
        (primitive as { __rateLimit?: RateLimitConfig }).__rateLimit = config.rateLimit;
      }
      return primitive;
    },
    request(
      event: string,
      config: {
        input?: Validator;
        rateLimit?: RateLimitConfig;
        run: (ctx: any, input: any) => unknown;
      },
    ) {
      const run = config.run;
      const primitive = requestFactory(
        event,
        async (ctx: { respond(value: unknown): void }, payload: unknown) => {
          const result = await run(ctx, payload);
          if (result !== undefined && result !== null) ctx.respond(result);
        },
        config.input ? { validator: config.input } : undefined,
      );
      if (config.rateLimit) {
        (primitive as { __rateLimit?: RateLimitConfig }).__rateLimit = config.rateLimit;
      }
      return primitive;
    },
    scheduled(taskId: string, config: { run: (ctx: any, data?: unknown) => void | Promise<void> }) {
      return {
        __wskitScheduledHandler: true as const,
        taskId,
        run: config.run,
      };
    },
    init(handler: (ctx: any) => void | Promise<void>) {
      registerOnce('init', onInit(handler));
    },
    connect(handler: (ctx: any) => void | Promise<void>) {
      registerOnce('connect', onConnect(handler));
    },
    disconnect(handler: (ctx: any) => void | Promise<void>) {
      registerOnce('disconnect', onDisconnect(handler));
    },
    error(handler: (ctx: any, error: unknown, event?: string) => void | Promise<void>) {
      registerOnce('error', onError(handler));
    },
    validationError(handler: (ctx: any, event: string, error: unknown) => void | Promise<void>) {
      registerOnce('validationError', onValidationError(handler));
    },
    shutdown(handler: (ctx: any) => void | Promise<void>) {
      registerOnce('shutdown', onShutdown(handler));
    },
    intercept(handler: (ctx: any, frame: InterceptFrame) => unknown | void) {
      registerOnce('intercept', interceptFactory(handler));
    },
    replay(hooks: CustomReplayHooks) {
      let build: ReplayCustomCapability['__buildCustomReplay'] | undefined;
      for (const cap of config.capabilities ?? []) {
        const candidate = (cap as Partial<ReplayCustomCapability>).__buildCustomReplay;
        if (candidate) {
          if (build) {
            throw new Error('[wskit] replay.custom() is listed more than once. List it once.');
          }
          build = candidate;
        }
      }
      if (!build) {
        throw new Error(
          '[wskit] base.replay() needs the replay.custom() capability. ' +
            'Add replay.custom() to capabilities.',
        );
      }
      registerOnce('replay', build(hooks));
    },
    assemble(...items: readonly Contribution[]) {
      const handlerPrimitives: Primitive[] = [];
      const scheduledBodies = new Map<
        string,
        (ctx: TaskContext, data?: unknown) => void | Promise<void>
      >();
      for (const item of items) {
        if ((item as { __wskitCapability?: unknown }).__wskitCapability) {
          throw new Error(
            '[wskit] A capability was passed to assemble(). List capabilities in ' +
              'define({ capabilities: [...] }) and pass only handlers (base.on, ...) to assemble().',
          );
        }
        if (isScheduledCarrier(item)) {
          if (scheduledBodies.has(item.taskId)) {
            throw new Error(
              `[wskit] Duplicate scheduled handler for '${item.taskId}' passed to assemble(). ` +
                'A task can only be bound once — drop the duplicate.',
            );
          }
          scheduledBodies.set(item.taskId, item.run);
          continue;
        }
        handlerPrimitives.push(item as Primitive);
      }
      assertUniqueHandlers(handlerPrimitives);

      const scheduledDeclarations = new Map<string, ScheduledDeclaration>();
      for (const cap of config.capabilities ?? []) {
        const declared = (cap as Partial<ScheduledCapability>).__scheduled;
        if (declared) {
          for (const [taskId, declaration] of declared)
            scheduledDeclarations.set(taskId, declaration);
        }
      }
      const scheduledPrimitives = mergeScheduled(scheduledDeclarations, scheduledBodies);

      let buildRateLimit: RateLimitCapability['__buildRateLimit'] | undefined;
      for (const cap of config.capabilities ?? []) {
        const build = (cap as Partial<RateLimitCapability>).__buildRateLimit;
        if (build) {
          if (buildRateLimit) {
            throw new Error(
              '[wskit] rateLimit() is listed more than once. Set one global rule, or none.',
            );
          }
          buildRateLimit = build;
        }
      }
      const rateLimitOverrides = new Map<string, RateLimitConfig>();
      for (const handler of handlerPrimitives) {
        const override = (handler as { __rateLimit?: RateLimitConfig }).__rateLimit;
        const event = (handler as { event?: string }).event;
        if (override && event !== undefined) rateLimitOverrides.set(event, override);
      }
      if (!buildRateLimit && rateLimitOverrides.size > 0) {
        throw new Error(
          '[wskit] a per-handler rateLimit override needs the rateLimit() capability. ' +
            'Add rateLimit() to capabilities.',
        );
      }
      const rateLimitPrimitive = buildRateLimit ? buildRateLimit(rateLimitOverrides) : null;

      const primitives: Primitive[] = [];
      if (config.upgrade) primitives.push(onUpgrade(adaptUpgrade(config.upgrade)));
      if (config.hibernation?.enabled) primitives.push(hibernationFactory(true));
      for (const cap of config.capabilities ?? []) primitives.push(...cap.__primitives);
      if (rateLimitPrimitive) primitives.push(rateLimitPrimitive);
      primitives.push(...lifecyclePrimitives);
      primitives.push(...handlerPrimitives);
      primitives.push(...scheduledPrimitives);

      const builtinReplayCount = primitives.filter(
        (p) => p.__wskit === 'replay' && !(p as { disabled?: boolean }).disabled,
      ).length;
      const hasCustomReplay = primitives.some((p) => p.__wskit === 'replayCustom');
      if (builtinReplayCount > 1) {
        throw new Error(
          '[wskit] built-in replay (replay.history() / replay.snapshot()) is listed more than ' +
            'once. Use one replay strategy per scope.',
        );
      }
      if (builtinReplayCount > 0 && hasCustomReplay) {
        throw new Error(
          '[wskit] built-in replay and custom base.replay() are both configured. ' +
            'Use one or the other.',
        );
      }

      const features = new Set<string>();
      for (const cap of config.capabilities ?? []) {
        for (const feature of cap.__features) features.add(feature);
      }
      if (config.hibernation?.enabled) features.add('hibernation');

      return Object.freeze({
        __wskit: 'server' as const,
        primitives: Object.freeze(primitives) as readonly Primitive[],
        __features: Object.freeze(features) as ReadonlySet<string>,
      });
    },
  };

  return base as unknown as Base<MergeSlots<SlotsOf<TCaps[number]>>, TEnv, TMeta, TCaps>;
}
