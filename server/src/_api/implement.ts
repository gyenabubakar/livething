/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Implementation half of the wskit contract/implement API. `implement(contract)`
 * returns an `Implementer` where you bind handlers, then call `.build()` to
 * produce a `ServerDefinition` the adapter can serve.
 */

import { error as coreErrorFactory } from '@wskit/core';
import { ack as ackFactory } from '~/ack/ack.ts';
import { compileChannelDef } from '~/channel/compile.ts';
import { ChannelImplement } from '~/channel/implement.ts';
import { dedup as dedupFactory } from '~/dedup/dedup.ts';
import { errors as errorsFactory } from '~/errors/primitive.ts';
import { heartbeat as heartbeatFactory } from '~/heartbeat/heartbeat.ts';
import { hibernation as hibernationFactory } from '~/hibernation/hibernation.ts';
import { compileIncomingDef } from '~/incoming/compile.ts';
import { intercept as interceptFactory } from '~/intercept/intercept.ts';
import {
  onBinary,
  onConnect,
  onDisconnect,
  onError,
  onInit,
  onShutdown,
  onUpgrade,
  onValidationError,
} from '~/lifecycle/lifecycle.ts';
import { compileNamespaceDef } from '~/namespace/compile.ts';
import { NamespaceImplement } from '~/namespace/implement.ts';
import { compileOutgoingDef } from '~/outgoing/compile.ts';
import { persistence as persistenceFactory } from '~/persistence/persistence.ts';
import { resolvePlan as resolveRateLimitPlan } from '~/rate-limit/plan.ts';
import { rateLimit as rateLimitFactory } from '~/rate-limit/rate-limit.ts';
import { handleReplay as customReplayFactory } from '~/replay/custom/custom.ts';
import { replay as replayFactory } from '~/replay/replay.ts';
import { compileRequestDef } from '~/request/compile.ts';
import { compileScheduledDef } from '~/scheduled/compile.ts';
import { sequence as sequenceFactory } from '~/sequence/sequence.ts';
import { compileRecordedStreamDef } from '~/stream-recorded/compile.ts';
import { compileResumableStreamDef } from '~/stream-resumable/compile.ts';
import { compileStreamDef } from '~/stream/compile.ts';
import { tagGroups as tagGroupsFactory } from '~/tags/tags.ts';
import type {
  BinaryHandler,
  ConnectHandler,
  DisconnectHandler,
  ErrorHandler,
  InitHandler,
  ShutdownHandler,
  UpgradeHandler,
  UpgradeResult,
  ValidationErrorHandler,
} from '~/lifecycle/lifecycle.ts';
import type { Primitive } from '~/primitive.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';
import type { CustomReplayOptions } from '~/replay/custom/custom.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type { Contract, ContractConfig } from './contract-types.ts';
import type { Ctx } from './ctx-types.ts';
import type {
  ChannelDef,
  Definition,
  IncomingDef,
  NamespaceDef,
  OutgoingDef,
  RecordedStreamDef,
  RequestDef,
  ResumableStreamDef,
  ScheduledDef,
  StreamDef,
} from './definitions.ts';
import type { HandlerMaps } from './handler-maps.ts';

// Re-export the sub-implementer classes from their new homes so external
// import paths (`@wskit/server`) keep working.
export { ChannelImplement } from '~/channel/implement.ts';
export { NamespaceImplement } from '~/namespace/implement.ts';

// ---------------------------------------------------------------------------
// Type-level handler signatures
// ---------------------------------------------------------------------------

type IncomingHandlerFor<C extends Contract, E extends keyof C['incoming']> = (
  ctx: Ctx<C>,
  payload: C['incoming'][E],
) => void | Promise<void>;

type RequestResponseOf<
  C extends Contract,
  E extends keyof C['requests'],
> = C['requests'][E] extends { response: infer R } ? R : void;

type RequestHandlerFor<C extends Contract, E extends keyof C['requests']> = (
  ctx: Ctx<C> & { respond(value: RequestResponseOf<C, E>): void },
  payload: C['requests'][E] extends { payload: infer P } ? P : never,
) => RequestResponseOf<C, E> | void | Promise<RequestResponseOf<C, E> | void>;

type StreamGeneratorFor<C extends Contract, E extends keyof C['streams']> = (
  ctx: Ctx<C> & {
    nudges(value: unknown): readonly {
      event: string;
      payload: unknown;
    }[];
  },
  payload: C['streams'][E] extends { payload: infer P } ? P : never,
) => AsyncGenerator<C['streams'][E] extends { chunk: infer Ch } ? Ch : unknown, void, unknown>;

type ScheduledHandlerFor<C extends Contract, I extends keyof C['scheduled']> = (
  ctx: any,
  data: C['scheduled'][I],
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Group (implementation-side organisational unit)
// ---------------------------------------------------------------------------

interface GroupRegistrations {
  incoming: Map<string, (ctx: any, payload: any) => void | Promise<void>>;
  requests: Map<string, (ctx: any, payload: any) => any>;
  streams: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>;
  scheduled: Map<string, (ctx: any, data: any) => void | Promise<void>>;
  channels: Map<string, ChannelImplement<any, any>>;
  namespaces: Map<string, NamespaceImplement<any, any>>;
  rateLimitOverrides: Map<string, RateLimitConfig>;
}

/**
 * Collects handlers that can be mounted into an `Implementer` later. Created
 * by `group(contract, ...)`. Lets you split your handlers across files
 * without changing the contract.
 */
export class GroupBuilder<C extends Contract> {
  /** @internal */
  readonly _reg: GroupRegistrations = {
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    scheduled: new Map(),
    channels: new Map(),
    namespaces: new Map(),
    rateLimitOverrides: new Map(),
  };

  /** Attach a handler for one client→server event declared on the contract. */
  on<E extends keyof C['incoming'] & string>(event: E, handler: IncomingHandlerFor<C, E>): this {
    this._reg.incoming.set(event, handler as any);
    return this;
  }

  /** Attach a handler for one request/response pair. Return a value or call `ctx.respond(...)`. */
  request<E extends keyof C['requests'] & string>(
    event: E,
    handler: RequestHandlerFor<C, E>,
  ): this {
    this._reg.requests.set(event, handler as any);
    return this;
  }

  /** Attach the generator that produces chunks for one server-pushed stream. */
  stream<E extends keyof C['streams'] & string>(
    event: E,
    generator: StreamGeneratorFor<C, E>,
  ): this {
    this._reg.streams.set(event, generator as any);
    return this;
  }

  /** Attach the body that runs each time a scheduled task fires. */
  scheduled<I extends keyof C['scheduled'] & string>(
    id: I,
    handler: ScheduledHandlerFor<C, I>,
  ): this {
    this._reg.scheduled.set(id, handler as any);
    return this;
  }

  /** Wire up handlers for one channel declared on the contract. */
  channel<N extends keyof C['channels'] & string>(
    name: N,
    fn: (ch: ChannelImplement<C, C['channels'][N]>) => unknown,
  ): this {
    const impl = new ChannelImplement<C, C['channels'][N]>();
    fn(impl);
    this._reg.channels.set(name, impl);
    return this;
  }

  /** Wire up handlers for one namespace declared on the contract. */
  namespace<N extends keyof C['namespaces'] & string>(
    name: N,
    fn: (ns: NamespaceImplement<C, C['namespaces'][N]>) => unknown,
  ): this {
    const impl = new NamespaceImplement<C, C['namespaces'][N]>();
    fn(impl);
    this._reg.namespaces.set(name, impl);
    return this;
  }

  /**
   * Override the resolved rate-limit rule for one top-level event from inside
   * a group. Same shape as `Implementer.rateLimit(...)`.
   */
  rateLimit<E extends (keyof C['incoming'] | keyof C['requests'] | keyof C['streams']) & string>(
    event: E,
    config: RateLimitConfig,
  ): this {
    this._reg.rateLimitOverrides.set(event, config);
    return this;
  }
}

/**
 * Define a reusable handler group against a contract. Pair with
 * `implement(contract).use(group)` to mount the group's handlers onto a
 * full implementation.
 *
 * Groups are **organisational** — they let you split implementation across
 * files. They do not change the contract.
 *
 * @example
 * ```ts
 * // auth.handlers.ts
 * import { group } from '@wskit/server';
 * import { chatContract } from './chat.contract';
 *
 * export const authHandlers = group(chatContract, (g) => g
 *   .on('login', (ctx, payload) => { ... })
 *   .on('logout', (ctx) => { ... })
 * );
 *
 * // main.ts
 * implement(chatContract).use(authHandlers).build();
 * ```
 */
export function group<C extends Contract>(
  _contract: C,
  fn: (g: GroupBuilder<C>) => unknown,
): GroupBuilder<C> {
  const builder = new GroupBuilder<C>();
  fn(builder);
  return builder;
}

// ---------------------------------------------------------------------------
// Implementer
// ---------------------------------------------------------------------------

interface ImplementerBag {
  incomingHandlers: Map<string, (ctx: any, payload: any) => void | Promise<void>>;
  requestHandlers: Map<string, (ctx: any, payload: any) => any>;
  streamGenerators: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>;
  resumableStreamGenerators: Map<
    string,
    (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>
  >;
  recordedStreamGenerators: Map<
    string,
    (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>
  >;
  scheduledHandlers: Map<string, (ctx: any, data: any) => void | Promise<void>>;
  channelImpls: Map<string, ChannelImplement<any, any>>;
  namespaceImpls: Map<string, NamespaceImplement<any, any>>;
  preIntercept?: (ctx: any, msg: { event: string; payload: unknown }) => any;
  postIntercepts: Map<string, (ctx: any, payload: unknown) => any>;
  rateLimitOverrides: Map<string, RateLimitConfig>;
  customReplayHooks?: CustomReplayOptions<'top'>;
  lifecycle: {
    onUpgrade?: UpgradeHandler;
    onInit?: InitHandler;
    onConnect?: ConnectHandler;
    onDisconnect?: DisconnectHandler;
    onShutdown?: ShutdownHandler;
    onError?: ErrorHandler;
    onValidationError?: ValidationErrorHandler;
    onBinary?: BinaryHandler;
  };
}

/**
 * The handler-collection surface returned by `implement(contract)`. Bind
 * handlers to declared events with `.on(...)`, `.request(...)`, `.stream(...)`,
 * etc. Finalize with `.build()` to produce a `ServerDefinition` the adapter
 * can serve.
 */
export class Implementer<C extends Contract> {
  /** @internal */
  readonly _contract: C;
  /** @internal */
  readonly _bag: ImplementerBag = {
    incomingHandlers: new Map(),
    requestHandlers: new Map(),
    streamGenerators: new Map(),
    resumableStreamGenerators: new Map(),
    recordedStreamGenerators: new Map(),
    scheduledHandlers: new Map(),
    channelImpls: new Map(),
    namespaceImpls: new Map(),
    postIntercepts: new Map(),
    rateLimitOverrides: new Map(),
    lifecycle: {},
  };

  constructor(contract: C) {
    this._contract = contract;
  }

  // ─────────────────── handler binding ───────────────────

  /**
   * Attach a handler for one client→server event declared on the contract.
   * Runs each time the client sends that event. The payload is already
   * validated against the schema you put in the contract.
   *
   * @example
   * ```ts
   * implement(chat).on('send-msg', (ctx, payload) => {
   *   ctx.broadcast('msg', { text: payload.text, from: ctx.identity });
   * });
   * ```
   */
  on<E extends keyof C['incoming'] & string>(event: E, handler: IncomingHandlerFor<C, E>): this {
    this._bag.incomingHandlers.set(event, handler as any);
    return this;
  }

  /**
   * Attach a handler for one request/response pair. The client awaits the
   * response. Either return the response value or call `ctx.respond(value)`.
   *
   * @example
   * ```ts
   * implement(chat).request('get-history', (ctx, { since }) => {
   *   return db.findMessagesSince(since);
   * });
   * ```
   */
  request<E extends keyof C['requests'] & string>(
    event: E,
    handler: RequestHandlerFor<C, E>,
  ): this {
    this._bag.requestHandlers.set(event, handler as any);
    return this;
  }

  /**
   * Attach the generator that produces chunks for one server-pushed stream.
   * The client receives every value you `yield`; the stream ends when the
   * generator returns or throws.
   *
   * @example
   * ```ts
   * implement(chat).stream('typing-feed', async function* (ctx) {
   *   for await (const event of typingEvents()) {
   *     yield event;
   *   }
   * });
   * ```
   */
  stream<E extends keyof C['streams'] & string>(
    event: E,
    generator: StreamGeneratorFor<C, E>,
  ): this {
    this._bag.streamGenerators.set(event, generator as any);
    return this;
  }

  /**
   * Attach the generator for a server-pushed stream that survives client
   * disconnects by re-running with a saved cursor. The generator receives
   * `ctx.stream.cursor` (the last cursor value, or `null` on first run) and
   * `ctx.stream.attempt` (1 first, 2+ on resume). Use
   * `ctx.stream.withCursor(chunk, cursor)` to yield a chunk with the cursor
   * the framework should persist.
   *
   * Requires `persistence: true` on the contract.
   *
   * @example
   * ```ts
   * implement(files).resumableStream('list-files', async function* (ctx, p) {
   *   const startAfter = (ctx.stream.cursor as { name: string } | null)?.name ?? null;
   *   for await (const file of db.listFilesAfter(p.folder, startAfter)) {
   *     yield ctx.stream.withCursor({ name: file.name }, { name: file.name });
   *   }
   * });
   * ```
   */
  resumableStream<E extends keyof C['resumableStreams'] & string>(
    event: E,
    generator: (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>,
  ): this {
    this._bag.resumableStreamGenerators.set(event, generator);
    return this;
  }

  /**
   * Attach the generator for a server-pushed stream whose chunks are buffered
   * in storage as they emit. On reconnect the framework replays the chunks
   * the client missed; the generator itself does not re-run by default. Best
   * for non-resumable sources (LLM tokens, third-party APIs).
   *
   * If the buffer hits its cap the framework throws `StreamAborted` with
   * `reason: 'buffer-full'` into the generator's `yield`. Wrap the yield in
   * try/catch to handle it.
   *
   * Requires `persistence: true` on the contract.
   *
   * @example
   * ```ts
   * implement(ai).recordedStream('ask-ai', async function* (ctx, p) {
   *   for await (const token of llm.tokens(p.prompt)) yield { token };
   * });
   * ```
   */
  recordedStream<E extends keyof C['recordedStreams'] & string>(
    event: E,
    generator: (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>,
  ): this {
    this._bag.recordedStreamGenerators.set(event, generator);
    return this;
  }

  /**
   * Attach the body that runs each time a scheduled task fires. Bind a
   * handler for every `scheduled(...)` declaration on the contract.
   *
   * @example
   * ```ts
   * implement(chat).scheduled('purge-stale', async (ctx, data) => {
   *   await db.purgeOlderThan(data.cutoff);
   * });
   * ```
   */
  scheduled<I extends keyof C['scheduled'] & string>(
    id: I,
    handler: ScheduledHandlerFor<C, I>,
  ): this {
    this._bag.scheduledHandlers.set(id, handler as any);
    return this;
  }

  /**
   * Wire up handlers for one channel declared on the contract. The callback
   * gets a channel sub-builder where you attach handlers, lifecycle hooks,
   * and intercepts that only apply inside that channel.
   *
   * @example
   * ```ts
   * implement(chat).channel('room', ch =>
   *   ch.on('send', (ctx, p) => ctx.channel.broadcast('msg', p))
   *     .onSubscribe(ctx => ctx.channel.broadcast('joined', { id: ctx.id }))
   * );
   * ```
   */
  channel<N extends keyof C['channels'] & string>(
    name: N,
    fn: (ch: ChannelImplement<C, C['channels'][N]>) => unknown,
  ): this {
    const impl = new ChannelImplement<C, C['channels'][N]>();
    fn(impl);
    this._bag.channelImpls.set(name, impl);
    return this;
  }

  /**
   * Wire up handlers for one namespace declared on the contract. The callback
   * gets a namespace sub-builder where you attach handlers and intercepts
   * that only apply inside that namespace.
   *
   * @example
   * ```ts
   * implement(chat).namespace('admin', ns =>
   *   ns.on('kick', (ctx, p) => ctx.kick(p.userId))
   * );
   * ```
   */
  namespace<N extends keyof C['namespaces'] & string>(
    name: N,
    fn: (ns: NamespaceImplement<C, C['namespaces'][N]>) => unknown,
  ): this {
    const impl = new NamespaceImplement<C, C['namespaces'][N]>();
    fn(impl);
    this._bag.namespaceImpls.set(name, impl);
    return this;
  }

  /**
   * Mount a group's handlers into this implementation. Groups are defined
   * with `group(contract, ...)` and let you split handler code across files.
   */
  use(g: GroupBuilder<C>): this {
    for (const [event, handler] of g._reg.incoming) {
      this._bag.incomingHandlers.set(event, handler);
    }
    for (const [event, handler] of g._reg.requests) {
      this._bag.requestHandlers.set(event, handler);
    }
    for (const [event, gen] of g._reg.streams) {
      this._bag.streamGenerators.set(event, gen);
    }
    for (const [id, handler] of g._reg.scheduled) {
      this._bag.scheduledHandlers.set(id, handler);
    }
    for (const [name, impl] of g._reg.channels) {
      this._bag.channelImpls.set(name, impl);
    }
    for (const [name, impl] of g._reg.namespaces) {
      this._bag.namespaceImpls.set(name, impl);
    }
    for (const [event, cfg] of g._reg.rateLimitOverrides) {
      this._bag.rateLimitOverrides.set(event, cfg);
    }
    return this;
  }

  // ─────────────────── lifecycle ───────────────────

  /**
   * Runs on the WebSocket upgrade request, before the connection opens. Use
   * it for auth and to set the connection's identity and meta. Return a
   * rejection from `RejectUpgrade(code, reason)` to refuse the upgrade.
   *
   * @example
   * ```ts
   * implement(chat).onUpgrade((request) => {
   *   const token = new URL(request.url).searchParams.get('token');
   *   const user = verifyToken(token);
   *   if (!user) throw RejectUpgrade(4001, 'invalid token');
   *   return { identity: user.id, meta: { username: user.name } };
   * });
   * ```
   */
  onUpgrade(
    handler: (
      request: Request,
      helpers: Parameters<UpgradeHandler>[1],
    ) => UpgradeResult | Promise<UpgradeResult>,
  ): this {
    this._bag.lifecycle.onUpgrade = handler as UpgradeHandler;
    return this;
  }

  /**
   * Runs once when the server instance starts. Use it for one-time setup like
   * running migrations or warming a cache. `ctx` here has no connection — it
   * carries `env`, `sql`, `kv`, `log`, `platform`.
   */
  onInit(handler: (ctx: any) => void | Promise<void>): this {
    this._bag.lifecycle.onInit = handler as InitHandler;
    return this;
  }

  /** Runs each time a client opens a WebSocket connection, after `onUpgrade` succeeds. */
  onConnect(handler: (ctx: Ctx<C>) => void | Promise<void>): this {
    this._bag.lifecycle.onConnect = handler as ConnectHandler;
    return this;
  }

  /** Runs each time a client connection closes, for any reason. */
  onDisconnect(handler: (ctx: Ctx<C>) => void | Promise<void>): this {
    this._bag.lifecycle.onDisconnect = handler as DisconnectHandler;
    return this;
  }

  /** Runs once when the server instance is shutting down. Closes/flushes side effects here. */
  onShutdown(handler: (ctx: any) => void | Promise<void>): this {
    this._bag.lifecycle.onShutdown = handler as ShutdownHandler;
    return this;
  }

  /**
   * Catches any error thrown by an event handler that the runtime didn't
   * already turn into a client `_error` frame. Use it for logging and
   * server-side reporting. The third argument is the event name when the
   * error came from an event handler.
   */
  onError(handler: (ctx: any, error: unknown, event?: string) => void | Promise<void>): this {
    this._bag.lifecycle.onError = handler as ErrorHandler;
    return this;
  }

  /**
   * Runs when an incoming payload fails its schema validation. Use it for
   * logging or auditing — the runtime already sends the client a
   * `validation-failed` `_error` frame, so handlers see nothing.
   */
  onValidationError(
    handler: (ctx: any, event: string, validationError: unknown) => void | Promise<void>,
  ): this {
    this._bag.lifecycle.onValidationError = handler as ValidationErrorHandler;
    return this;
  }

  /**
   * Handle raw binary frames the client sends. Requires `binary: true` on the
   * contract. Build-time check rejects this method if the flag is off.
   */
  onBinary(handler: (ctx: Ctx<C>, data: ArrayBuffer) => void | Promise<void>): this {
    this._bag.lifecycle.onBinary = handler as BinaryHandler;
    return this;
  }

  // ─────────────────── intercept ───────────────────

  /**
   * Attach a middleware-style hook that runs on incoming events.
   *
   * - `intercept(handler)` — runs BEFORE schema validation on every event.
   *   Use it for things like rate limiting or auth checks. Throw to bail.
   * - `intercept(event, handler)` — runs AFTER validation, BEFORE the event's
   *   own handler. Scoped to one event.
   *
   * @example
   * ```ts
   * implement(chat)
   *   .intercept((ctx, msg) => { if (isBanned(ctx.identity)) throw Disconnect(...); })
   *   .intercept('send-msg', (ctx, payload) => { audit(payload); });
   * ```
   */
  intercept(handler: (ctx: any, message: { event: string; payload: unknown }) => any): this;
  intercept<E extends keyof C['incoming'] & string>(
    event: E,
    handler: (ctx: Ctx<C>, payload: C['incoming'][E]) => any,
  ): this;
  intercept(arg1: any, arg2?: any): this {
    if (typeof arg1 === 'string') {
      this._bag.postIntercepts.set(arg1, arg2);
    } else {
      this._bag.preIntercept = arg1;
    }
    return this;
  }

  // ─────────────────── per-handler rate limit ───────────────────

  /**
   * Override the resolved rate-limit rule for one top-level event. Missing
   * fields fall back to the top-level resolved rule (contract `rateLimit:`).
   *
   * Use this when one event needs a tighter or looser cap than the rest of
   * its scope — for example a token-stream endpoint inside an otherwise
   * generous AI namespace.
   *
   * @example
   * ```ts
   * implement(chat)
   *   .rateLimit('expensive-op', { enabled: true, max: 5 })
   *   .on('expensive-op', (ctx, p) => { ... });
   * ```
   */
  rateLimit<E extends (keyof C['incoming'] | keyof C['requests'] | keyof C['streams']) & string>(
    event: E,
    config: RateLimitConfig,
  ): this {
    this._bag.rateLimitOverrides.set(event, config);
    return this;
  }

  // ─────────────────── custom replay ───────────────────

  /**
   * Plug in your own replay logic at the top level. You provide an `onReplay`
   * (and optionally `onBeforeSend` / `onAfterSend`); your code owns where the
   * data lives and how it's resent. `ctx` and `msg` inside the hooks are typed
   * against the contract.
   */
  customReplay(hooks: CustomReplayOptions<'top'>): this {
    this._bag.customReplayHooks = hooks;
    return this;
  }

  // ─────────────────── build ───────────────────

  /**
   * Finalize the implementation into a `ServerDefinition` the adapter can run.
   */
  build(): ServerDefinition<readonly Primitive[], any> {
    const primitives: Primitive[] = [];
    const config = this._contract.__config as ContractConfig;

    // Catch handlers attached for features that aren't switched on. Easy to
    // mess up and silently never fire, so we fail loud at build time.
    if (this._bag.lifecycle.onBinary && !config.binary) {
      throw new Error(
        '[wskit] onBinary handler registered but `binary: true` is not set on the contract. ' +
          'Add `binary: true` to your contract config, or remove the onBinary handler.',
      );
    }
    if (this._bag.customReplayHooks && config.replay !== undefined) {
      throw new Error(
        '[wskit] .customReplay(...) is registered alongside `replay:` on the contract. ' +
          'Use one or the other — built-in replay (contract config) or custom replay (.customReplay()).',
      );
    }
    if (hasDurableStreamDef(config.definitions) && !config.persistence) {
      throw new Error(
        '[wskit] resumableStream / recordedStream require `persistence: true` on the contract. ' +
          'Add `persistence: true` to the contract config.',
      );
    }
    assertDurableStreamsTopLevelOnly(config.definitions);

    // ── Feature primitives ──────────────────────────────────────────────────
    if (config.persistence) primitives.push(persistenceFactory());
    if (config.hibernation) primitives.push(hibernationFactory(true));
    if (config.heartbeat) {
      const opts =
        typeof config.heartbeat === 'object'
          ? config.heartbeat
          : ({} as { intervalMs?: number; timeoutMs?: number });
      primitives.push(heartbeatFactory({ timeout: opts.timeoutMs ?? opts.intervalMs ?? 30_000 }));
    }
    if (config.sequence) {
      const opts = typeof config.sequence === 'object' ? config.sequence : {};
      primitives.push(sequenceFactory({ persist: opts.persist }));
    }
    if (config.dedup) primitives.push(dedupFactory());
    if (config.ack) primitives.push(ackFactory());
    if (config.replay !== undefined) {
      if (config.replay === true) {
        primitives.push(replayFactory());
      } else if (config.replay === false) {
        primitives.push(replayFactory(false));
      } else {
        primitives.push(replayFactory(config.replay as any));
      }
    }
    // Custom replay goes through .customReplay() and is kept separate from
    // contract.replay so the hooks can be fully typed against the contract.
    if (this._bag.customReplayHooks) {
      primitives.push(customReplayFactory(this._bag.customReplayHooks as any));
    }

    // ── Rate limit ───────────────────────────────────────────────────────────
    // Collect per-handler overrides from every impl level keyed by scope key.
    const overrides = new Map<string, Map<string, RateLimitConfig>>();
    if (this._bag.rateLimitOverrides.size > 0) {
      overrides.set('top', new Map(this._bag.rateLimitOverrides));
    }
    for (const [name, impl] of this._bag.channelImpls) {
      if (impl._bag.rateLimitOverrides.size === 0) continue;
      overrides.set(`channel:${name}`, new Map(impl._bag.rateLimitOverrides));
    }
    for (const [nsName, nsImpl] of this._bag.namespaceImpls) {
      if (nsImpl._bag.rateLimitOverrides.size > 0) {
        overrides.set(`ns:${nsName}`, new Map(nsImpl._bag.rateLimitOverrides));
      }
      for (const [chName, chImpl] of nsImpl._bag.channelImpls) {
        if (chImpl._bag.rateLimitOverrides.size === 0) continue;
        overrides.set(`ns:${nsName}:channel:${chName}`, new Map(chImpl._bag.rateLimitOverrides));
      }
    }
    const rateLimitPlan = resolveRateLimitPlan({
      contractRateLimit: config.rateLimit,
      definitions: config.definitions,
      overrides,
    });
    if (rateLimitPlan) primitives.push(rateLimitFactory(rateLimitPlan));

    // ── Tag groups ───────────────────────────────────────────────────────────
    if (config.tagGroups?.ephemeral && config.tagGroups.ephemeral.length > 0) {
      primitives.push(tagGroupsFactory('ephemeral', config.tagGroups.ephemeral));
    }
    if (config.tagGroups?.persistent && config.tagGroups.persistent.length > 0) {
      primitives.push(tagGroupsFactory('persistent', config.tagGroups.persistent));
    }

    // ── Errors ───────────────────────────────────────────────────────────────
    if (config.errors && config.errors.length > 0) {
      // Each entry is either a built ErrorDefWithFactory from the core
      // `error()` factory (a function) or a plain ErrorContractDef shape
      // from contract-style declaration (has `_: 'error'`).
      const errorDefs = config.errors.map((e: any) =>
        typeof e === 'function' ? e : makeRuntimeErrorDef(e.code, e.schema),
      );
      if (errorDefs.length > 0) {
        primitives.push(errorsFactory(...(errorDefs as [any, ...any[]])));
      }
    }

    // ── Modules ──────────────────────────────────────────────────────────────
    // Modules go in BEFORE lifecycle and definitions so their hooks register
    // first and run before user handlers (matches legacy `.use(MyModule())`
    // order on the old builder chain).
    if (config.modules && config.modules.length > 0) {
      for (const mod of config.modules) {
        primitives.push(mod as Primitive);
      }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────
    if (this._bag.lifecycle.onUpgrade) primitives.push(onUpgrade(this._bag.lifecycle.onUpgrade));
    if (this._bag.lifecycle.onInit) primitives.push(onInit(this._bag.lifecycle.onInit));
    if (this._bag.lifecycle.onConnect) primitives.push(onConnect(this._bag.lifecycle.onConnect));
    if (this._bag.lifecycle.onDisconnect)
      primitives.push(onDisconnect(this._bag.lifecycle.onDisconnect));
    if (this._bag.lifecycle.onShutdown) primitives.push(onShutdown(this._bag.lifecycle.onShutdown));
    if (this._bag.lifecycle.onError) primitives.push(onError(this._bag.lifecycle.onError));
    if (this._bag.lifecycle.onValidationError)
      primitives.push(onValidationError(this._bag.lifecycle.onValidationError));
    if (this._bag.lifecycle.onBinary) primitives.push(onBinary(this._bag.lifecycle.onBinary));

    // ── Intercepts ───────────────────────────────────────────────────────────
    if (this._bag.preIntercept) primitives.push(interceptFactory(this._bag.preIntercept));
    for (const [event, handler] of this._bag.postIntercepts) {
      primitives.push(interceptFactory(event, handler));
    }

    // ── Top-level definitions ────────────────────────────────────────────────
    primitives.push(
      ...this._buildDefinitions(config.definitions, {
        incomingHandlers: this._bag.incomingHandlers,
        requestHandlers: this._bag.requestHandlers,
        streamGenerators: this._bag.streamGenerators,
        resumableStreamGenerators: this._bag.resumableStreamGenerators,
        recordedStreamGenerators: this._bag.recordedStreamGenerators,
        scheduledHandlers: this._bag.scheduledHandlers,
        channelImpls: this._bag.channelImpls,
        namespaceImpls: this._bag.namespaceImpls,
      }),
    );

    return Object.freeze({
      __wskit: 'server' as const,
      primitives: Object.freeze(primitives) as readonly Primitive[],
    });
  }

  /** @internal */
  private _buildDefinitions(
    definitions: readonly Definition[],
    handlers: HandlerMaps,
  ): Primitive[] {
    const out: Primitive[] = [];
    const recurse = this._buildDefinitions.bind(this);

    for (const def of definitions) {
      switch (def._) {
        case 'incoming':
          out.push(compileIncomingDef(def as IncomingDef, handlers.incomingHandlers));
          break;
        case 'outgoing':
          out.push(compileOutgoingDef(def as OutgoingDef));
          break;
        case 'request':
          out.push(compileRequestDef(def as RequestDef, handlers.requestHandlers));
          break;
        case 'stream':
          out.push(compileStreamDef(def as StreamDef, handlers.streamGenerators));
          break;
        case 'resumable-stream':
          out.push(
            compileResumableStreamDef(
              def as ResumableStreamDef,
              handlers.resumableStreamGenerators,
            ),
          );
          break;
        case 'recorded-stream':
          out.push(
            compileRecordedStreamDef(def as RecordedStreamDef, handlers.recordedStreamGenerators),
          );
          break;
        case 'scheduled':
          out.push(compileScheduledDef(def as ScheduledDef, handlers.scheduledHandlers));
          break;
        case 'channel':
          out.push(compileChannelDef(def as ChannelDef, handlers.channelImpls, recurse));
          break;
        case 'namespace':
          out.push(compileNamespaceDef(def as NamespaceDef, handlers.namespaceImpls, recurse));
          break;
        default: {
          // exhaustiveness check
          const _unreachable: never = def;
          void _unreachable;
        }
      }
    }

    return out;
  }
}

/**
 * Create an implementer for the given contract. Bind handlers with the
 * fluent methods, then call `.build()` to finalize.
 */
export function implement<C extends Contract>(contract: C): Implementer<C> {
  return new Implementer(contract);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasDurableStreamDef(defs: readonly Definition[]): boolean {
  for (const def of defs) {
    if (def._ === 'resumable-stream' || def._ === 'recorded-stream') return true;
    if (def._ === 'channel' && hasDurableStreamDef((def as ChannelDef).definitions)) return true;
    if (def._ === 'namespace' && hasDurableStreamDef((def as NamespaceDef).definitions))
      return true;
  }
  return false;
}

function assertDurableStreamsTopLevelOnly(defs: readonly Definition[], parentScope?: string): void {
  for (const def of defs) {
    if ((def._ === 'resumable-stream' || def._ === 'recorded-stream') && parentScope) {
      throw new Error(
        `[wskit] ${def._ === 'resumable-stream' ? 'resumableStream' : 'recordedStream'} "${
          (def as { name: string }).name
        }" is declared inside ${parentScope}. Durable streams are top-level only in v1. ` +
          'Move the declaration out of the channel/namespace, or open a follow-up issue if you need it scoped.',
      );
    }
    if (def._ === 'channel') {
      const ch = def as ChannelDef;
      const key = typeof ch.pattern === 'string' ? ch.pattern : ch.pattern.key;
      assertDurableStreamsTopLevelOnly(ch.definitions, `channel "${key}"`);
    }
    if (def._ === 'namespace') {
      const ns = def as NamespaceDef;
      assertDurableStreamsTopLevelOnly(ns.definitions, `namespace "${ns.name}"`);
    }
  }
}

// The new API uses plain `error(code, schema?)` but the engine's `errors()`
// primitive wants an ErrorDef with a callable factory. Wrap as needed.
function makeRuntimeErrorDef(code: string, schema?: any) {
  return schema ? coreErrorFactory(code, schema) : coreErrorFactory(code);
}
