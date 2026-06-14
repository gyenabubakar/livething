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
import type { TypeMarker } from '~/_api/definitions.ts';
import type { InitContext, ShutdownContext } from '~/context.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { UpgradeHandler, UpgradeResult } from '~/lifecycle/lifecycle.ts';
import type { Primitive } from '~/primitive.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type { Validator } from '~/types.ts';
import type { AppCtx } from './app-ctx.ts';
import type {
  Capability,
  Contribution,
  MergeSlots,
  SlotsOf,
  UnionToIntersection,
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
  TCaps extends readonly Capability[] = readonly Capability[],
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
  /** Runs each time the client sends this event, with the validated payload. */
  run(ctx: AppCtx<TSlots, TEnv, TMeta>, input: InferInput<TSchema>): void | Promise<void>;
}

/** Builder methods a capability adds to `base`, merged across every listed capability. */
type MethodsOf<TCaps extends readonly Capability[]> = UnionToIntersection<
  NonNullable<TCaps[number]['__methods']>
>;

/**
 * The builder returned by `define(...)`. Carries the methods every server has
 * (`on`, the lifecycle hooks, `intercept`, `assemble`) plus any methods the
 * listed capabilities add.
 */
export type Base<TSlots, TEnv, TMeta, TCaps extends readonly Capability[]> = CoreBase<
  TSlots,
  TEnv,
  TMeta
> &
  MethodsOf<TCaps>;

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

/**
 * Reject a capability passed to `assemble(...)` and refuse two handlers that
 * bind the same event. Both are build-time mistakes (§21) better caught here,
 * with a clear message, than deep in engine boot.
 */
function assertValidHandlers(handlers: readonly Primitive[]): void {
  const seen = new Map<symbol, Set<string>>();
  for (const handler of handlers) {
    if ((handler as { __wskitCapability?: unknown }).__wskitCapability) {
      throw new Error(
        '[wskit] A capability was passed to assemble(). List capabilities in ' +
          'define({ capabilities: [...] }) and pass only handlers (base.on, ...) to assemble().',
      );
    }
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
  }
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
  const TCaps extends readonly Capability[] = readonly [],
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
      return incomingFactory(
        event,
        config.run as any,
        config.input ? { validator: config.input } : undefined,
      );
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
    assemble(...handlers: readonly Contribution[]) {
      assertValidHandlers(handlers as readonly Primitive[]);
      const primitives: Primitive[] = [];
      if (config.upgrade) primitives.push(onUpgrade(adaptUpgrade(config.upgrade)));
      if (config.hibernation?.enabled) primitives.push(hibernationFactory(true));
      for (const cap of config.capabilities ?? []) primitives.push(...cap.__primitives);
      primitives.push(...lifecyclePrimitives);
      primitives.push(...(handlers as readonly Primitive[]));

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
