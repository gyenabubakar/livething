/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * `implement(contract)` returns an `Implementer` that collects handler
 * registrations against the contract's declared events. `.build()` walks the
 * contract, pairs declarations with handlers, and returns a `ServerDefinition`
 * the engine can run as-is.
 */

import { error as coreErrorFactory } from '@wskit/core';
import { ack as ackFactory } from '~/ack/ack.ts';
import { channel as channelFactory, scope as scopeFactory } from '~/channel/channel.ts';
import {
  onBeforeSubscribe,
  onSessionEnd as onSessionEndFactory,
  onSubscribe,
  onUnsubscribe,
} from '~/channel/lifecycle.ts';
import { dedup as dedupFactory } from '~/dedup/dedup.ts';
import { errors as errorsFactory } from '~/errors/primitive.ts';
import { heartbeat as heartbeatFactory } from '~/heartbeat/heartbeat.ts';
import { hibernation as hibernationFactory } from '~/hibernation/hibernation.ts';
import { incoming as incomingFactory } from '~/incoming/incoming.ts';
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
import { namespace as namespaceFactory } from '~/namespace/namespace.ts';
import { outgoing as outgoingFactory } from '~/outgoing/outgoing.ts';
import { persistentMarker } from '~/persistence/channel-marker.ts';
import { persistence as persistenceFactory } from '~/persistence/persistence.ts';
import { handleReplay as customReplayFactory } from '~/replay/custom/custom.ts';
import { replay as replayFactory } from '~/replay/replay.ts';
import { request as requestFactory } from '~/request/request.ts';
import { scheduled as scheduledFactory } from '~/scheduled/scheduled.ts';
import { sequence as sequenceFactory } from '~/sequence/sequence.ts';
import { generate as generateFactory, stream as streamFactory } from '~/stream/stream.ts';
import { tagGroups as tagGroupsFactory } from '~/tags/tags.ts';
import type { ScopeDeclaration } from '~/channel/channel.ts';
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
import type { CustomReplayOptions } from '~/replay/custom/custom.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type { Contract, ContractConfig, Group } from './contract-types.ts';
import type { ChannelCtx, Ctx, NamespaceCtx } from './ctx-types.ts';
import type {
  ChannelDef,
  Definition,
  IncomingDef,
  NamespaceDef,
  NudgeDef,
  OutgoingDef,
  RequestDef,
  ScheduledDef,
  StreamDef,
  UseDef,
} from './definitions.ts';

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
// Channel sub-implementer
// ---------------------------------------------------------------------------

interface ChannelHandlerBag {
  incomingHandlers: Map<string, (ctx: any, payload: any) => void | Promise<void>>;
  requestHandlers: Map<string, (ctx: any, payload: any) => any>;
  streamGenerators: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>;
  onBeforeSubscribeHandler?: (ctx: any, data?: any) => void | Promise<void>;
  onSubscribeHandler?: (ctx: any) => void | Promise<void>;
  onUnsubscribeHandler?: (ctx: any) => void | Promise<void>;
  onSessionEndHandler?: (ctx: any) => void | Promise<void>;
  preIntercept?: (ctx: any, message: { event: string; payload: unknown }) => any;
  postIntercepts: Map<string, (ctx: any, payload: any) => any>;
  customReplayHooks?: CustomReplayOptions<'channel'>;
}

export class ChannelImplement<C extends Contract, ChC = any> {
  /** @internal */
  readonly _bag: ChannelHandlerBag = {
    incomingHandlers: new Map(),
    requestHandlers: new Map(),
    streamGenerators: new Map(),
    postIntercepts: new Map(),
  };

  on<E extends keyof FieldOf<ChC, 'incoming'> & string>(
    event: E,
    handler: (
      ctx: ChannelCtx<ChC, C>,
      payload: FieldOf<ChC, 'incoming'>[E],
    ) => void | Promise<void>,
  ): this {
    this._bag.incomingHandlers.set(event, handler as any);
    return this;
  }

  request<E extends keyof FieldOf<ChC, 'requests'> & string>(
    event: E,
    handler: (
      ctx: ChannelCtx<ChC, C> & {
        respond(value: FieldOf<ChC, 'requests'>[E] extends { response: infer R } ? R : void): void;
      },
      payload: FieldOf<ChC, 'requests'>[E] extends { payload: infer P } ? P : never,
    ) =>
      | (FieldOf<ChC, 'requests'>[E] extends { response: infer R } ? R : void)
      | void
      | Promise<(FieldOf<ChC, 'requests'>[E] extends { response: infer R } ? R : void) | void>,
  ): this {
    this._bag.requestHandlers.set(event, handler as any);
    return this;
  }

  stream<E extends keyof FieldOf<ChC, 'streams'> & string>(
    event: E,
    generator: (
      ctx: ChannelCtx<ChC, C> & {
        nudges(v: unknown): readonly { event: string; payload: unknown }[];
      },
      payload: FieldOf<ChC, 'streams'>[E] extends { payload: infer P } ? P : never,
    ) => AsyncGenerator<
      FieldOf<ChC, 'streams'>[E] extends { chunk: infer Ch } ? Ch : unknown,
      void,
      unknown
    >,
  ): this {
    this._bag.streamGenerators.set(event, generator as any);
    return this;
  }

  onBeforeSubscribe(
    handler: (ctx: ChannelCtx<ChC, C>, data?: unknown) => void | Promise<void>,
  ): this {
    this._bag.onBeforeSubscribeHandler = handler as any;
    return this;
  }

  onSubscribe(handler: (ctx: ChannelCtx<ChC, C>) => void | Promise<void>): this {
    this._bag.onSubscribeHandler = handler as any;
    return this;
  }

  onUnsubscribe(handler: (ctx: ChannelCtx<ChC, C>) => void | Promise<void>): this {
    this._bag.onUnsubscribeHandler = handler as any;
    return this;
  }

  onSessionEnd(handler: (ctx: ChannelCtx<ChC, C>) => void | Promise<void>): this {
    this._bag.onSessionEndHandler = handler as any;
    return this;
  }

  intercept(
    handler: (ctx: ChannelCtx<ChC, C>, message: { event: string; payload: unknown }) => any,
  ): this;
  intercept<E extends keyof FieldOf<ChC, 'incoming'> & string>(
    event: E,
    handler: (ctx: ChannelCtx<ChC, C>, payload: FieldOf<ChC, 'incoming'>[E]) => any,
  ): this;
  intercept(arg1: any, arg2?: any): this {
    if (typeof arg1 === 'string') {
      this._bag.postIntercepts.set(arg1, arg2);
    } else {
      this._bag.preIntercept = arg1;
    }
    return this;
  }

  /**
   * Register a custom replay strategy scoped to this channel. The hooks own
   * their own storage and resend logic; pass an `onReplay` plus any of
   * `onBeforeSend` / `onAfterSend`.
   */
  customReplay(hooks: CustomReplayOptions<'channel'>): this {
    this._bag.customReplayHooks = hooks;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Namespace sub-implementer
// ---------------------------------------------------------------------------

interface NamespaceHandlerBag {
  incomingHandlers: Map<string, (ctx: any, payload: any) => void | Promise<void>>;
  requestHandlers: Map<string, (ctx: any, payload: any) => any>;
  streamGenerators: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>;
  channelImpls: Map<string, ChannelImplement<any, any>>;
  preIntercept?: (ctx: any, message: { event: string; payload: unknown }) => any;
  postIntercepts: Map<string, (ctx: any, payload: any) => any>;
}

export class NamespaceImplement<C extends Contract, NsC = any> {
  /** @internal */
  readonly _bag: NamespaceHandlerBag = {
    incomingHandlers: new Map(),
    requestHandlers: new Map(),
    streamGenerators: new Map(),
    channelImpls: new Map(),
    postIntercepts: new Map(),
  };

  on<E extends keyof FieldOf<NsC, 'incoming'> & string>(
    event: E,
    handler: (
      ctx: NamespaceCtx<NsC, C>,
      payload: FieldOf<NsC, 'incoming'>[E],
    ) => void | Promise<void>,
  ): this {
    this._bag.incomingHandlers.set(event, handler as any);
    return this;
  }

  request<E extends keyof FieldOf<NsC, 'requests'> & string>(
    event: E,
    handler: (
      ctx: NamespaceCtx<NsC, C> & {
        respond(value: FieldOf<NsC, 'requests'>[E] extends { response: infer R } ? R : void): void;
      },
      payload: FieldOf<NsC, 'requests'>[E] extends { payload: infer P } ? P : never,
    ) =>
      | (FieldOf<NsC, 'requests'>[E] extends { response: infer R } ? R : void)
      | void
      | Promise<(FieldOf<NsC, 'requests'>[E] extends { response: infer R } ? R : void) | void>,
  ): this {
    this._bag.requestHandlers.set(event, handler as any);
    return this;
  }

  stream<E extends keyof FieldOf<NsC, 'streams'> & string>(
    event: E,
    generator: (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>,
  ): this {
    this._bag.streamGenerators.set(event, generator as any);
    return this;
  }

  channel<N extends keyof FieldOf<NsC, 'channels'> & string>(
    name: N,
    fn: (ch: ChannelImplement<C, FieldOf<NsC, 'channels'>[N]>) => unknown,
  ): this {
    const impl = new ChannelImplement<C, FieldOf<NsC, 'channels'>[N]>();
    fn(impl);
    this._bag.channelImpls.set(name, impl);
    return this;
  }

  intercept(
    handler: (ctx: NamespaceCtx<NsC, C>, message: { event: string; payload: unknown }) => any,
  ): this;
  intercept<E extends keyof FieldOf<NsC, 'incoming'> & string>(
    event: E,
    handler: (ctx: NamespaceCtx<NsC, C>, payload: FieldOf<NsC, 'incoming'>[E]) => any,
  ): this;
  intercept(arg1: any, arg2?: any): this {
    if (typeof arg1 === 'string') {
      this._bag.postIntercepts.set(arg1, arg2);
    } else {
      this._bag.preIntercept = arg1;
    }
    return this;
  }
}

type FieldOf<T, K extends string> = T extends Record<K, infer V> ? V : Record<string, any>;

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
}

export class GroupBuilder<C extends Contract> {
  /** @internal */
  readonly _reg: GroupRegistrations = {
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    scheduled: new Map(),
    channels: new Map(),
    namespaces: new Map(),
  };

  on<E extends keyof C['incoming'] & string>(event: E, handler: IncomingHandlerFor<C, E>): this {
    this._reg.incoming.set(event, handler as any);
    return this;
  }

  request<E extends keyof C['requests'] & string>(
    event: E,
    handler: RequestHandlerFor<C, E>,
  ): this {
    this._reg.requests.set(event, handler as any);
    return this;
  }

  stream<E extends keyof C['streams'] & string>(
    event: E,
    generator: StreamGeneratorFor<C, E>,
  ): this {
    this._reg.streams.set(event, generator as any);
    return this;
  }

  scheduled<I extends keyof C['scheduled'] & string>(
    id: I,
    handler: ScheduledHandlerFor<C, I>,
  ): this {
    this._reg.scheduled.set(id, handler as any);
    return this;
  }

  channel<N extends keyof C['channels'] & string>(
    name: N,
    fn: (ch: ChannelImplement<C, C['channels'][N]>) => unknown,
  ): this {
    const impl = new ChannelImplement<C, C['channels'][N]>();
    fn(impl);
    this._reg.channels.set(name, impl);
    return this;
  }

  namespace<N extends keyof C['namespaces'] & string>(
    name: N,
    fn: (ns: NamespaceImplement<C, C['namespaces'][N]>) => unknown,
  ): this {
    const impl = new NamespaceImplement<C, C['namespaces'][N]>();
    fn(impl);
    this._reg.namespaces.set(name, impl);
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
  scheduledHandlers: Map<string, (ctx: any, data: any) => void | Promise<void>>;
  channelImpls: Map<string, ChannelImplement<any, any>>;
  namespaceImpls: Map<string, NamespaceImplement<any, any>>;
  preIntercept?: (ctx: any, msg: { event: string; payload: unknown }) => any;
  postIntercepts: Map<string, (ctx: any, payload: unknown) => any>;
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
    scheduledHandlers: new Map(),
    channelImpls: new Map(),
    namespaceImpls: new Map(),
    postIntercepts: new Map(),
    lifecycle: {},
  };

  constructor(contract: C) {
    this._contract = contract;
  }

  // ─────────────────── handler binding ───────────────────

  on<E extends keyof C['incoming'] & string>(event: E, handler: IncomingHandlerFor<C, E>): this {
    this._bag.incomingHandlers.set(event, handler as any);
    return this;
  }

  request<E extends keyof C['requests'] & string>(
    event: E,
    handler: RequestHandlerFor<C, E>,
  ): this {
    this._bag.requestHandlers.set(event, handler as any);
    return this;
  }

  stream<E extends keyof C['streams'] & string>(
    event: E,
    generator: StreamGeneratorFor<C, E>,
  ): this {
    this._bag.streamGenerators.set(event, generator as any);
    return this;
  }

  scheduled<I extends keyof C['scheduled'] & string>(
    id: I,
    handler: ScheduledHandlerFor<C, I>,
  ): this {
    this._bag.scheduledHandlers.set(id, handler as any);
    return this;
  }

  channel<N extends keyof C['channels'] & string>(
    name: N,
    fn: (ch: ChannelImplement<C, C['channels'][N]>) => unknown,
  ): this {
    const impl = new ChannelImplement<C, C['channels'][N]>();
    fn(impl);
    this._bag.channelImpls.set(name, impl);
    return this;
  }

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
   * Mount a group's handlers into this implementation. Groups are defined with
   * `group(contract, ...)` and let you split handler code across files.
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
    return this;
  }

  // ─────────────────── lifecycle ───────────────────

  onUpgrade(
    handler: (
      request: Request,
      helpers: Parameters<UpgradeHandler>[1],
    ) => UpgradeResult | Promise<UpgradeResult>,
  ): this {
    this._bag.lifecycle.onUpgrade = handler as UpgradeHandler;
    return this;
  }

  onInit(handler: (ctx: any) => void | Promise<void>): this {
    this._bag.lifecycle.onInit = handler as InitHandler;
    return this;
  }

  onConnect(handler: (ctx: Ctx<C>) => void | Promise<void>): this {
    this._bag.lifecycle.onConnect = handler as ConnectHandler;
    return this;
  }

  onDisconnect(handler: (ctx: Ctx<C>) => void | Promise<void>): this {
    this._bag.lifecycle.onDisconnect = handler as DisconnectHandler;
    return this;
  }

  onShutdown(handler: (ctx: any) => void | Promise<void>): this {
    this._bag.lifecycle.onShutdown = handler as ShutdownHandler;
    return this;
  }

  onError(handler: (ctx: any, error: unknown, event?: string) => void | Promise<void>): this {
    this._bag.lifecycle.onError = handler as ErrorHandler;
    return this;
  }

  onValidationError(
    handler: (ctx: any, event: string, validationError: unknown) => void | Promise<void>,
  ): this {
    this._bag.lifecycle.onValidationError = handler as ValidationErrorHandler;
    return this;
  }

  onBinary(handler: (ctx: Ctx<C>, data: ArrayBuffer) => void | Promise<void>): this {
    this._bag.lifecycle.onBinary = handler as BinaryHandler;
    return this;
  }

  // ─────────────────── intercept ───────────────────

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

  // ─────────────────── custom replay ───────────────────

  /**
   * Register a top-level custom replay strategy. The hooks own their own
   * storage and resend logic; pass an `onReplay` plus any of `onBeforeSend`
   * / `onAfterSend`.
   *
   * `ctx` and `msg` inside the hooks are typed against the contract.
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

    // ── Boot-time validation: handler registered for a feature that's off ──
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
    // Custom replay hooks registered via .customReplay() — separate from
    // contract.replay so the hooks can be fully typed against the contract.
    if (this._bag.customReplayHooks) {
      primitives.push(customReplayFactory(this._bag.customReplayHooks as any));
    }

    // ── Tag groups ───────────────────────────────────────────────────────────
    if (config.tagGroups?.ephemeral && config.tagGroups.ephemeral.length > 0) {
      primitives.push(tagGroupsFactory('ephemeral', config.tagGroups.ephemeral));
    }
    if (config.tagGroups?.persistent && config.tagGroups.persistent.length > 0) {
      primitives.push(tagGroupsFactory('persistent', config.tagGroups.persistent));
    }

    // ── Errors ───────────────────────────────────────────────────────────────
    if (config.errors && config.errors.length > 0) {
      // Each entry is either an already-built ErrorDefWithFactory from the
      // core `error()` factory (typeof function) or a plain ErrorContractDef
      // shape from our own contract-style declaration (has `_: 'error'`).
      const errorDefs = config.errors.map((e: any) =>
        typeof e === 'function' ? e : makeRuntimeErrorDef(e.code, e.schema),
      );
      if (errorDefs.length > 0) {
        primitives.push(errorsFactory(...(errorDefs as [any, ...any[]])));
      }
    }

    // ── Modules (from contract.modules) ─────────────────────────────────────
    // Modules are pushed BEFORE lifecycle and definitions so their hooks
    // register first and run before user handlers (matches legacy order
    // where `.use(MyModule(...))` was called early on the builder chain).
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

  /**
   * Walk a definitions tuple and emit the primitives that match each one,
   * pairing event names with handlers from the given handler maps.
   *
   * @internal
   */
  private _buildDefinitions(
    definitions: readonly Definition[],
    handlers: {
      incomingHandlers: Map<string, (ctx: any, payload: any) => any>;
      requestHandlers: Map<string, (ctx: any, payload: any) => any>;
      streamGenerators: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>;
      scheduledHandlers: Map<string, (ctx: any, data: any) => any>;
      channelImpls: Map<string, ChannelImplement<any, any>>;
      namespaceImpls: Map<string, NamespaceImplement<any, any>>;
    },
  ): Primitive[] {
    const out: Primitive[] = [];

    for (const def of definitions) {
      switch (def._) {
        case 'incoming': {
          const d = def as IncomingDef;
          const handler = handlers.incomingHandlers.get(d.name);
          if (!handler) {
            throw new Error(
              `[wskit] No handler registered for incoming('${d.name}'). Call implement(c).on('${d.name}', ...).`,
            );
          }
          out.push(
            incomingFactory(d.name, handler as any, d.schema ? { validator: d.schema } : undefined),
          );
          break;
        }
        case 'outgoing': {
          const d = def as OutgoingDef;
          out.push(outgoingFactory(d.name));
          break;
        }
        case 'request': {
          const d = def as RequestDef;
          const handler = handlers.requestHandlers.get(d.name);
          if (!handler) {
            throw new Error(
              `[wskit] No handler registered for request('${d.name}'). Call implement(c).request('${d.name}', ...).`,
            );
          }
          // Adapt the handler to use ctx.respond — the existing request runtime
          // expects the handler to call ctx.respond(value) rather than return.
          async function adapted(ctx: any, payload: any): Promise<void> {
            const result = await (handler as any)(ctx, payload);
            if (result !== undefined) ctx.respond(result);
          }
          out.push(
            requestFactory(d.name, adapted, {
              validator: d.payload,
              responseSchema: d.response,
            }),
          );
          break;
        }
        case 'stream': {
          const d = def as StreamDef;
          const generator = handlers.streamGenerators.get(d.name);
          if (!generator) {
            throw new Error(
              `[wskit] No generator registered for stream('${d.name}'). Call implement(c).stream('${d.name}', ...).`,
            );
          }
          const streamPrim = streamFactory(
            {
              event: d.name,
              validator: d.payload,
              broadcast: d.broadcast,
              allowConcurrent: d.allowConcurrent,
            },
            ...d.nudges.map((n: NudgeDef) => ({ event: n.name, validator: n.schema })),
          );
          out.push(streamPrim);
          out.push(generateFactory(streamPrim, generator as any));
          break;
        }
        case 'scheduled': {
          const d = def as ScheduledDef;
          const handler = handlers.scheduledHandlers.get(d.id);
          if (!handler) {
            throw new Error(
              `[wskit] No handler registered for scheduled('${d.id}'). Call implement(c).scheduled('${d.id}', ...).`,
            );
          }
          out.push(
            scheduledFactory(d.id, (b) => {
              let bb: any = b;
              if (d.data) bb = bb.data(d.data);
              if (d.retry !== undefined) bb = bb.retry(d.retry);
              if (d.every !== undefined) bb = bb.every(d.every);
              return bb.run(handler);
            }),
          );
          break;
        }
        case 'channel': {
          const d = def as ChannelDef;
          const patternKey =
            typeof d.pattern === 'string' ? d.pattern : (d.pattern as ScopeDeclaration).key;
          const impl = handlers.channelImpls.get(patternKey);
          // Channels without handlers are allowed — declaration-only is valid.

          const childPrimitives: Primitive[] = [];

          // Persistence marker
          if (d.persistent !== undefined) {
            childPrimitives.push(persistentMarker(d.persistent));
          }

          // Replay config — channel-scoped (built-in replay only). Custom
          // replay for a channel scope is registered on the channel sub-
          // implementer's .customReplay() and folded in below.
          if (d.replay !== undefined) {
            if (d.replay === false) {
              childPrimitives.push(replayFactory(false));
            } else if (d.replay === true) {
              childPrimitives.push(replayFactory());
            } else {
              childPrimitives.push(replayFactory(d.replay as any));
            }
          }

          // Channel-scoped custom replay registered via ch.customReplay(...).
          if (impl?._bag.customReplayHooks) {
            childPrimitives.push(customReplayFactory(impl._bag.customReplayHooks as any));
          }

          // Walk child definitions, pairing handlers from the channel impl
          const childHandlers = {
            incomingHandlers: impl?._bag.incomingHandlers ?? new Map(),
            requestHandlers: impl?._bag.requestHandlers ?? new Map(),
            streamGenerators: impl?._bag.streamGenerators ?? new Map(),
            scheduledHandlers: new Map(),
            channelImpls: new Map(),
            namespaceImpls: new Map(),
          };
          childPrimitives.push(...this._buildDefinitions(d.definitions, childHandlers));

          // Channel intercepts
          if (impl?._bag.preIntercept) {
            childPrimitives.push(interceptFactory(impl._bag.preIntercept));
          }
          if (impl) {
            for (const [event, handler] of impl._bag.postIntercepts) {
              childPrimitives.push(interceptFactory(event, handler));
            }
          }

          // Channel lifecycle hooks
          if (impl?._bag.onBeforeSubscribeHandler) {
            childPrimitives.push(onBeforeSubscribe(impl._bag.onBeforeSubscribeHandler));
          }
          if (impl?._bag.onSubscribeHandler) {
            childPrimitives.push(onSubscribe(impl._bag.onSubscribeHandler));
          }
          if (impl?._bag.onUnsubscribeHandler) {
            childPrimitives.push(onUnsubscribe(impl._bag.onUnsubscribeHandler));
          }
          if (impl?._bag.onSessionEndHandler) {
            childPrimitives.push(onSessionEndFactory(impl._bag.onSessionEndHandler));
          }

          // Channel pattern can be a string or a ScopeDeclaration
          const pattern =
            typeof d.pattern === 'string'
              ? d.pattern
              : scopeFactory(
                  (d.pattern as ScopeDeclaration).key,
                  (d.pattern as ScopeDeclaration).pattern,
                );
          out.push(channelFactory(pattern as any, ...(childPrimitives as any[])));
          break;
        }
        case 'namespace': {
          const d = def as NamespaceDef;
          const impl = handlers.namespaceImpls.get(d.name);

          const childHandlers = {
            incomingHandlers: impl?._bag.incomingHandlers ?? new Map(),
            requestHandlers: impl?._bag.requestHandlers ?? new Map(),
            streamGenerators: impl?._bag.streamGenerators ?? new Map(),
            scheduledHandlers: new Map(),
            channelImpls: impl?._bag.channelImpls ?? new Map(),
            namespaceImpls: new Map(),
          };
          const childPrimitives = this._buildDefinitions(d.definitions, childHandlers);
          if (impl?._bag.preIntercept) {
            childPrimitives.unshift(interceptFactory(impl._bag.preIntercept));
          }
          if (impl) {
            for (const [event, handler] of impl._bag.postIntercepts) {
              childPrimitives.push(interceptFactory(event, handler));
            }
          }
          out.push(namespaceFactory(d.name, ...(childPrimitives as any[])));
          break;
        }
        case 'use': {
          // Groups already merged their handlers into this._bag.* during .use(g) call.
          // The contract-level `use()` just splats the group's items here for declarations.
          const d = def as UseDef<Group>;
          const g = d.group as Group;
          // Group's contract carries `definitions` if we set it. For now this is a no-op
          // since group is implementation-side only (per user's directive).
          // We still need to surface any declaration items the group might have carried.
          // Future: contract-level groups would extend this.
          void g;
          break;
        }
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

/**
 * Build a runtime ErrorDef compatible with the existing `errors()` primitive.
 * The new API uses plain `error(code, schema?)` while the engine wants the
 * existing error-definition shape with a callable factory.
 */
function makeRuntimeErrorDef(code: string, schema?: any) {
  return schema ? coreErrorFactory(code, schema) : coreErrorFactory(code);
}
