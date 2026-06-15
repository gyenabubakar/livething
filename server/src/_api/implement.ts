/* oxlint-disable @typescript-eslint/no-explicit-any */

import { error as coreErrorFactory } from '@wskit/core';
import { collectUnique } from '~/_engine/compile/utils.ts';
import { sweepDurableStreams } from '~/_engine/stream-durable/runtime.ts';
import { ensureDurableStreamSchema } from '~/_engine/stream-durable/storage.ts';
import { ack as ackFactory } from '~/ack/ack.ts';
import { compileChannelDef } from '~/channel/compile.ts';
import { ChannelImplement } from '~/channel/implement.ts';
import { dedup as dedupFactory } from '~/dedup/dedup.ts';
import { errors as errorsFactory } from '~/errors/primitive.ts';
import { hibernation as hibernationFactory } from '~/hibernation/hibernation.ts';
import { compileIncomingDef } from '~/incoming/compile.ts';
import { intercept as interceptFactory } from '~/intercept/intercept.ts';
import { keepalive as keepaliveFactory } from '~/keepalive/keepalive.ts';
import {
  onConnect,
  onDisconnect,
  onError,
  onInit,
  onShutdown,
  onUpgrade,
  onValidationError,
} from '~/lifecycle/lifecycle.ts';
import { compileOutgoingDef } from '~/outgoing/compile.ts';
import { persistence as persistenceFactory } from '~/persistence/persistence.ts';
import { resolvePlan as resolveRateLimitPlan } from '~/rate-limit/plan.ts';
import { rateLimit as rateLimitFactory } from '~/rate-limit/rate-limit.ts';
import { handleReplay as customReplayFactory } from '~/replay/custom/custom.ts';
import { replay as replayFactory } from '~/replay/replay.ts';
import { compileRequestDef } from '~/request/compile.ts';
import { compileScheduledDef } from '~/scheduled/compile.ts';
import { scheduled as scheduledFactory } from '~/scheduled/scheduled.ts';
import { sequence as sequenceFactory } from '~/sequence/sequence.ts';
import { compileRecordedStreamDef } from '~/stream-recorded/compile.ts';
import { compileResumableStreamDef } from '~/stream-resumable/compile.ts';
import { compileStreamDef } from '~/stream/compile.ts';
import { resolveTagGroupDefs, tagGroups as tagGroupsFactory } from '~/tags/tags.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type {
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
import { setOnce } from './handler-maps.ts';
import type { Contract, ContractConfig } from './contract-types.ts';
import type { Ctx } from './ctx-types.ts';
import type {
  ChannelDef,
  Definition,
  IncomingDef,
  OutgoingDef,
  RecordedStreamDef,
  RequestDef,
  ResumableStreamDef,
  ScheduledDef,
  StreamDef,
} from './definitions.ts';
import type { HandlerMaps } from './handler-maps.ts';
import type {
  PlainStreamGenerator,
  RecordedStreamGenerator,
  ResumableStreamGenerator,
} from './stream-handler-types.ts';

export { ChannelImplement } from '~/channel/implement.ts';

type IncomingHandlerFor<C extends Contract, E extends keyof C['incoming']> = (
  ctx: Ctx<C>,
  payload: C['incoming'][E],
) => void | Promise<void>;

type RequestResponseOf<
  C extends Contract,
  E extends keyof C['requests'],
> = C['requests'][E] extends {
  response: infer R;
}
  ? R
  : void;

type RequestHandlerFor<C extends Contract, E extends keyof C['requests']> = (
  ctx: Ctx<C> & { respond(value: RequestResponseOf<C, E>): void },
  payload: C['requests'][E] extends { payload: infer P } ? P : never,
) => void | Promise<void>;

type StreamGeneratorFor<C extends Contract, E extends keyof C['streams']> = (
  ...args: Parameters<PlainStreamGenerator<Ctx<C>, C['streams'][E]>>
) => ReturnType<PlainStreamGenerator<Ctx<C>, C['streams'][E]>>;

type ResumableStreamGeneratorFor<C extends Contract, E extends keyof C['resumableStreams']> = (
  ...args: Parameters<ResumableStreamGenerator<Ctx<C>, C['resumableStreams'][E]>>
) => ReturnType<ResumableStreamGenerator<Ctx<C>, C['resumableStreams'][E]>>;

type RecordedStreamGeneratorFor<C extends Contract, E extends keyof C['recordedStreams']> = (
  ...args: Parameters<RecordedStreamGenerator<Ctx<C>, C['recordedStreams'][E]>>
) => ReturnType<RecordedStreamGenerator<Ctx<C>, C['recordedStreams'][E]>>;

type ScheduledHandlerFor<C extends Contract, I extends keyof C['scheduled']> = (
  ctx: any,
  data: C['scheduled'][I],
) => void | Promise<void>;

interface GroupRegistrations {
  incoming: Map<string, (ctx: any, payload: any) => void | Promise<void>>;
  requests: Map<string, (ctx: any, payload: any) => any>;

  streams: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>;
  resumableStreams: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>;
  recordedStreams: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>;

  scheduled: Map<string, (ctx: any, data: any) => void | Promise<void>>;

  channels: Map<string, ChannelImplement<any, any>>;

  intercept?: (ctx: any, frame: InterceptFrame) => any;
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
  };
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
    resumableStreams: new Map(),
    recordedStreams: new Map(),
    scheduled: new Map(),
    channels: new Map(),
    rateLimitOverrides: new Map(),
    lifecycle: {},
  };

  /** Attach a handler for one client→server event declared on the contract. */
  on<E extends keyof C['incoming'] & string>(event: E, handler: IncomingHandlerFor<C, E>): this {
    setOnce(this._reg.incoming, event, {
      value: handler as any,
      kind: 'incoming',
      where: 'this group',
    });
    return this;
  }

  /** Attach a handler for one request/response pair. Call `ctx.respond(...)`. */
  request<E extends keyof C['requests'] & string>(
    event: E,
    handler: RequestHandlerFor<C, E>,
  ): this {
    setOnce(this._reg.requests, event, {
      value: handler as any,
      kind: 'request',
      where: 'this group',
    });
    return this;
  }

  /** Attach the generator that produces chunks for one server-pushed stream. */
  stream<E extends keyof C['streams'] & string>(
    event: E,
    generator: StreamGeneratorFor<C, E>,
  ): this {
    setOnce(this._reg.streams, event, {
      value: generator as any,
      kind: 'stream',
      where: 'this group',
    });
    return this;
  }

  /** Attach the generator for a resumable stream. Same surface as `Implementer.resumableStream`. */
  resumableStream<E extends keyof C['resumableStreams'] & string>(
    event: E,
    generator: ResumableStreamGeneratorFor<C, E>,
  ): this {
    setOnce(this._reg.resumableStreams, event, {
      value: generator,
      kind: 'resumableStream',
      where: 'this group',
    });
    return this;
  }

  /** Attach the generator for a recorded stream. Same surface as `Implementer.recordedStream`. */
  recordedStream<E extends keyof C['recordedStreams'] & string>(
    event: E,
    generator: RecordedStreamGeneratorFor<C, E>,
  ): this {
    setOnce(this._reg.recordedStreams, event, {
      value: generator,
      kind: 'recordedStream',
      where: 'this group',
    });
    return this;
  }

  /** Attach the body that runs each time a scheduled task fires. */
  scheduled<I extends keyof C['scheduled'] & string>(
    id: I,
    handler: ScheduledHandlerFor<C, I>,
  ): this {
    setOnce(this._reg.scheduled, id, {
      value: handler as any,
      kind: 'scheduled',
      where: 'this group',
    });
    return this;
  }

  /** Wire up handlers for one channel declared on the contract. */
  channel<N extends keyof C['channels'] & string>(
    name: N,
    fn: (ch: ChannelImplement<C, C['channels'][N]>) => unknown,
  ): this {
    const impl = new ChannelImplement<C, C['channels'][N]>();
    fn(impl);
    setOnce(this._reg.channels, name, { value: impl, kind: 'channel', where: 'this group' });
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
    setOnce(this._reg.rateLimitOverrides, event, {
      value: config,
      kind: 'rateLimit override',
      where: 'this group',
    });
    return this;
  }

  /**
   * Middleware-style hook scoped to this group's eventual mount point. Runs
   * before schema validation on every event. Same shape as
   * `Implementer.intercept`.
   */
  intercept(handler: (ctx: any, frame: InterceptFrame) => any): this {
    if (this._reg.intercept) {
      throw new Error(
        '[wskit] Duplicate intercept on this group. Only one intercept can be attached.',
      );
    }
    this._reg.intercept = handler;
    return this;
  }

  /** Plug in custom replay hooks. Same shape as `Implementer.customReplay`. */
  customReplay(hooks: CustomReplayOptions<'top'>): this {
    if (this._reg.customReplayHooks) {
      throw new Error(
        '[wskit] Duplicate .customReplay() on this group. Only one custom-replay strategy can be attached.',
      );
    }
    this._reg.customReplayHooks = hooks;
    return this;
  }

  /** Attach the WebSocket upgrade hook. Same surface as `Implementer.onUpgrade`. */
  onUpgrade(
    handler: (
      request: Request,
      helpers: Parameters<UpgradeHandler>[1],
    ) => UpgradeResult | Promise<UpgradeResult>,
  ): this {
    assertLifecycleOnce(this._reg.lifecycle, 'onUpgrade', 'this group');
    this._reg.lifecycle.onUpgrade = handler as UpgradeHandler;
    return this;
  }

  /** Attach the server-init hook. Same surface as `Implementer.onInit`. */
  onInit(handler: (ctx: any) => void | Promise<void>): this {
    assertLifecycleOnce(this._reg.lifecycle, 'onInit', 'this group');
    this._reg.lifecycle.onInit = handler as InitHandler;
    return this;
  }

  /** Attach the per-connection connect hook. Same surface as `Implementer.onConnect`. */
  onConnect(handler: (ctx: Ctx<C>) => void | Promise<void>): this {
    assertLifecycleOnce(this._reg.lifecycle, 'onConnect', 'this group');
    this._reg.lifecycle.onConnect = handler as ConnectHandler;
    return this;
  }

  /** Attach the per-connection disconnect hook. Same surface as `Implementer.onDisconnect`. */
  onDisconnect(handler: (ctx: Ctx<C>) => void | Promise<void>): this {
    assertLifecycleOnce(this._reg.lifecycle, 'onDisconnect', 'this group');
    this._reg.lifecycle.onDisconnect = handler as DisconnectHandler;
    return this;
  }

  /** Attach the server-shutdown hook. Same surface as `Implementer.onShutdown`. */
  onShutdown(handler: (ctx: any) => void | Promise<void>): this {
    assertLifecycleOnce(this._reg.lifecycle, 'onShutdown', 'this group');
    this._reg.lifecycle.onShutdown = handler as ShutdownHandler;
    return this;
  }

  /** Attach the unhandled-error hook. Same surface as `Implementer.onError`. */
  onError(handler: (ctx: Ctx<C>, error: unknown, event?: string) => void | Promise<void>): this {
    assertLifecycleOnce(this._reg.lifecycle, 'onError', 'this group');
    this._reg.lifecycle.onError = handler as ErrorHandler;
    return this;
  }

  /** Attach the validation-error hook. Same surface as `Implementer.onValidationError`. */
  onValidationError(
    handler: (ctx: Ctx<C>, event: string, error: unknown) => void | Promise<void>,
  ): this {
    assertLifecycleOnce(this._reg.lifecycle, 'onValidationError', 'this group');
    this._reg.lifecycle.onValidationError = handler as ValidationErrorHandler;
    return this;
  }
}

function mergeLifecycleHook(
  target: ImplementerBag['lifecycle'],
  source: GroupRegistrations['lifecycle'],
  hook:
    | 'onUpgrade'
    | 'onInit'
    | 'onConnect'
    | 'onDisconnect'
    | 'onShutdown'
    | 'onError'
    | 'onValidationError',
): void {
  const incoming = source[hook];
  if (!incoming) return;
  if (target[hook]) {
    throw new Error(
      `[wskit] Duplicate .${hook}() from a group. The implementer or another group already set one.`,
    );
  }
  target[hook] = incoming as any;
}

type LifecycleHookName =
  | 'onUpgrade'
  | 'onInit'
  | 'onConnect'
  | 'onDisconnect'
  | 'onShutdown'
  | 'onError'
  | 'onValidationError';

function assertLifecycleOnce(
  lifecycle: Partial<Record<LifecycleHookName, unknown>>,
  hook: LifecycleHookName,
  where: string,
): void {
  if (lifecycle[hook]) {
    throw new Error(
      `[wskit] Duplicate .${hook}() on ${where}. Only one ${hook} hook can be attached.`,
    );
  }
}

/**
 * Define a reusable handler group against a contract. Pair with
 * `implement(contract).use(group)` to mount the group's handlers onto a
 * full implementation.
 *
 * Groups are **organizational** — they let you split implementation across
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

  intercept?: (ctx: any, frame: InterceptFrame) => any;
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
    rateLimitOverrides: new Map(),
    lifecycle: {},
  };

  constructor(contract: C) {
    this._contract = contract;
  }

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
    setOnce(this._bag.incomingHandlers, event, {
      value: handler as any,
      kind: 'incoming',
      where: 'the implementer',
    });
    return this;
  }

  /**
   * Attach a handler for one request/response pair. The client awaits the
   * response. Call `ctx.respond(value)`.
   *
   * @example
   * ```ts
   * implement(chat).request('get-history', async (ctx, { since }) => {
   *   ctx.respond(await db.findMessagesSince(since));
   * });
   * ```
   */
  request<E extends keyof C['requests'] & string>(
    event: E,
    handler: RequestHandlerFor<C, E>,
  ): this {
    setOnce(this._bag.requestHandlers, event, {
      value: handler as any,
      kind: 'request',
      where: 'the implementer',
    });
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
    setOnce(this._bag.streamGenerators, event, {
      value: generator as any,
      kind: 'stream',
      where: 'the implementer',
    });
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
    generator: ResumableStreamGeneratorFor<C, E>,
  ): this {
    setOnce(this._bag.resumableStreamGenerators, event, {
      value: generator,
      kind: 'resumableStream',
      where: 'the implementer',
    });
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
    generator: RecordedStreamGeneratorFor<C, E>,
  ): this {
    setOnce(this._bag.recordedStreamGenerators, event, {
      value: generator,
      kind: 'recordedStream',
      where: 'the implementer',
    });
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
    setOnce(this._bag.scheduledHandlers, id, {
      value: handler as any,
      kind: 'scheduled',
      where: 'the implementer',
    });
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
    setOnce(this._bag.channelImpls, name, {
      value: impl,
      kind: 'channel',
      where: 'the implementer',
    });
    return this;
  }

  /**
   * Mount a group's handlers into this implementation. Groups are defined
   * with `group(contract, ...)` and let you split handler code across files.
   */
  use(g: GroupBuilder<C>): this {
    const from = 'a group';
    for (const [event, handler] of g._reg.incoming) {
      setOnce(this._bag.incomingHandlers, event, { value: handler, kind: 'incoming', where: from });
    }
    for (const [event, handler] of g._reg.requests) {
      setOnce(this._bag.requestHandlers, event, { value: handler, kind: 'request', where: from });
    }
    for (const [event, gen] of g._reg.streams) {
      setOnce(this._bag.streamGenerators, event, { value: gen, kind: 'stream', where: from });
    }
    for (const [event, gen] of g._reg.resumableStreams) {
      setOnce(this._bag.resumableStreamGenerators, event, {
        value: gen,
        kind: 'resumableStream',
        where: from,
      });
    }
    for (const [event, gen] of g._reg.recordedStreams) {
      setOnce(this._bag.recordedStreamGenerators, event, {
        value: gen,
        kind: 'recordedStream',
        where: from,
      });
    }
    for (const [id, handler] of g._reg.scheduled) {
      setOnce(this._bag.scheduledHandlers, id, { value: handler, kind: 'scheduled', where: from });
    }
    for (const [name, impl] of g._reg.channels) {
      setOnce(this._bag.channelImpls, name, { value: impl, kind: 'channel', where: from });
    }
    for (const [event, cfg] of g._reg.rateLimitOverrides) {
      setOnce(this._bag.rateLimitOverrides, event, {
        value: cfg,
        kind: 'rateLimit override',
        where: from,
      });
    }
    if (g._reg.intercept) {
      if (this._bag.intercept) {
        throw new Error(
          '[wskit] Duplicate intercept from a group. The implementer or another group already set one.',
        );
      }
      this._bag.intercept = g._reg.intercept;
    }
    if (g._reg.customReplayHooks) {
      if (this._bag.customReplayHooks) {
        throw new Error(
          '[wskit] Duplicate .customReplay() from a group. The implementer or another group already set one.',
        );
      }
      this._bag.customReplayHooks = g._reg.customReplayHooks;
    }
    mergeLifecycleHook(this._bag.lifecycle, g._reg.lifecycle, 'onUpgrade');
    mergeLifecycleHook(this._bag.lifecycle, g._reg.lifecycle, 'onInit');
    mergeLifecycleHook(this._bag.lifecycle, g._reg.lifecycle, 'onConnect');
    mergeLifecycleHook(this._bag.lifecycle, g._reg.lifecycle, 'onDisconnect');
    mergeLifecycleHook(this._bag.lifecycle, g._reg.lifecycle, 'onShutdown');
    mergeLifecycleHook(this._bag.lifecycle, g._reg.lifecycle, 'onError');
    mergeLifecycleHook(this._bag.lifecycle, g._reg.lifecycle, 'onValidationError');
    return this;
  }

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
    assertLifecycleOnce(this._bag.lifecycle, 'onUpgrade', 'the implementer');
    this._bag.lifecycle.onUpgrade = handler as UpgradeHandler;
    return this;
  }

  /**
   * Runs once when the server instance starts. Use it for one-time setup like
   * running migrations or warming a cache. `ctx` here has no connection — it
   * carries `env`, `sql`, `kv`, `log`, `platform`.
   */
  onInit(handler: (ctx: any) => void | Promise<void>): this {
    assertLifecycleOnce(this._bag.lifecycle, 'onInit', 'the implementer');
    this._bag.lifecycle.onInit = handler as InitHandler;
    return this;
  }

  /** Runs each time a client opens a WebSocket connection, after `onUpgrade` succeeds. */
  onConnect(handler: (ctx: Ctx<C>) => void | Promise<void>): this {
    assertLifecycleOnce(this._bag.lifecycle, 'onConnect', 'the implementer');
    this._bag.lifecycle.onConnect = handler as ConnectHandler;
    return this;
  }

  /** Runs each time a client connection closes, for any reason. */
  onDisconnect(handler: (ctx: Ctx<C>) => void | Promise<void>): this {
    assertLifecycleOnce(this._bag.lifecycle, 'onDisconnect', 'the implementer');
    this._bag.lifecycle.onDisconnect = handler as DisconnectHandler;
    return this;
  }

  /** Runs once when the server instance is shutting down. Closes/flushes side effects here. */
  onShutdown(handler: (ctx: any) => void | Promise<void>): this {
    assertLifecycleOnce(this._bag.lifecycle, 'onShutdown', 'the implementer');
    this._bag.lifecycle.onShutdown = handler as ShutdownHandler;
    return this;
  }

  /**
   * Catches any error thrown by an event handler that the runtime didn't
   * already turn into a client `__error__` frame. Use it for logging and
   * server-side reporting. The third argument is the event name when the
   * error came from an event handler.
   */
  onError(handler: (ctx: any, error: unknown, event?: string) => void | Promise<void>): this {
    assertLifecycleOnce(this._bag.lifecycle, 'onError', 'the implementer');
    this._bag.lifecycle.onError = handler as ErrorHandler;
    return this;
  }

  /**
   * Runs when an incoming payload fails its schema validation. Use it for
   * logging or auditing — the runtime already sends the client a
   * `validation-failed` `__error__` frame, so handlers see nothing.
   */
  onValidationError(
    handler: (ctx: any, event: string, validationError: unknown) => void | Promise<void>,
  ): this {
    assertLifecycleOnce(this._bag.lifecycle, 'onValidationError', 'the implementer');
    this._bag.lifecycle.onValidationError = handler as ValidationErrorHandler;
    return this;
  }

  /**
   * Attach a middleware-style hook that runs on every incoming event before
   * schema validation. Use it for things like rate limiting, auth checks, or
   * payload rewriting. Throw `Block` to drop the frame, `Disconnect` to close
   * the connection, or return a new value to replace the payload.
   *
   * Use `matches(contract, ...)` or `unsafeCast(contract, ...)` from
   * `@wskit/server` inside the handler to narrow `frame.payload` to a typed
   * shape per event.
   *
   * @example
   * ```ts
   * import { matches } from '@wskit/server';
   * import { Disconnect } from '@wskit/server/errors';
   * import { CloseCodes } from '@wskit/core';
   *
   * implement(chat)
   *   .intercept((ctx, frame) => {
   *     if (isBanned(ctx.identity)) throw Disconnect(CloseCodes.BANNED, 'banned');
   *     if (matches(chat, 'send-msg', frame)) audit(frame.payload);
   *   });
   * ```
   */
  intercept(handler: (ctx: Ctx<C>, frame: InterceptFrame) => any): this {
    if (this._bag.intercept) {
      throw new Error(
        '[wskit] Duplicate intercept on the implementer. Only one intercept can be attached.',
      );
    }
    this._bag.intercept = handler;
    return this;
  }

  /**
   * Override the resolved rate-limit rule for one top-level event. Missing
   * fields fall back to the top-level resolved rule (contract `rateLimit:`).
   *
   * Use this when one event needs a tighter or looser cap than the rest of
   * its scope — for example one expensive endpoint in an otherwise generous
   * contract.
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
    setOnce(this._bag.rateLimitOverrides, event, {
      value: config,
      kind: 'rateLimit override',
      where: 'the implementer',
    });
    return this;
  }

  /**
   * Plug in your own replay logic at the top level. You provide an `onReplay`
   * (and optionally `onBeforeSend` / `onAfterSend`); your code owns where the
   * data lives and how it's resent. `ctx` and `msg` inside the hooks are typed
   * against the contract.
   */
  customReplay(hooks: CustomReplayOptions<'top'>): this {
    if (this._bag.customReplayHooks) {
      throw new Error(
        '[wskit] Duplicate .customReplay() on the implementer. Only one custom-replay strategy can be attached.',
      );
    }
    this._bag.customReplayHooks = hooks;
    return this;
  }

  /**
   * Finalize the implementation into a `ServerDefinition` the adapter can run.
   *
   * The contract type `C` is carried through on the return type so
   * `InferClient<typeof built>` can recover the full client contract. Dropping
   * it (returning `any`) silently collapses every inferred client slot to `any`.
   */
  build(): ServerDefinition<readonly Primitive[], C> {
    const primitives: Primitive[] = [];
    const config = this._contract.__config as ContractConfig;

    // Catch handlers attached for features that aren't switched on. Easy to
    // mess up and silently never fire, so we fail loud at build time.
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

    if (config.persistence) primitives.push(persistenceFactory());

    if (hasDurableStreamDef(config.definitions)) {
      primitives.push(
        scheduledFactory('__wskit:stream-durable-sweep', (b) =>
          b.every(60_000).run((ctx: { sql: Parameters<typeof sweepDurableStreams>[0]['sql'] }) => {
            ensureDurableStreamSchema(ctx.sql);
            sweepDurableStreams({ sql: ctx.sql });
          }),
        ),
      );
    }

    if (config.hibernation) primitives.push(hibernationFactory(true));
    if (config.keepalive) {
      primitives.push(keepaliveFactory(config.keepalive));
    }
    if (config.sequence) {
      const opts = typeof config.sequence === 'object' ? config.sequence : {};
      primitives.push(sequenceFactory({ persist: opts.persist, batchSize: opts.batchSize }));
    }
    if (config.dedup) {
      const dedupOpts = typeof config.dedup === 'object' ? config.dedup : undefined;
      primitives.push(dedupFactory(dedupOpts));
    }
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

    const overrides = new Map<string, Map<string, RateLimitConfig>>();
    if (this._bag.rateLimitOverrides.size > 0) {
      overrides.set('top', new Map(this._bag.rateLimitOverrides));
    }
    for (const [name, impl] of this._bag.channelImpls) {
      if (impl._bag.rateLimitOverrides.size === 0) continue;
      overrides.set(`channel:${name}`, new Map(impl._bag.rateLimitOverrides));
    }
    const rateLimitPlan = resolveRateLimitPlan({
      contractRateLimit: config.rateLimit,
      definitions: config.definitions,
      overrides,
    });
    if (rateLimitPlan) primitives.push(rateLimitFactory(rateLimitPlan));

    if (config.tags) {
      const tagDefs = resolveTagGroupDefs(config.tags);
      const ephemeral = tagDefs
        .filter((def) => def.kind === 'ephemeral')
        .map((def) => ({ name: def.name, schema: def.schema }));
      const persistent = tagDefs
        .filter((def) => def.kind === 'persistent')
        .map((def) => ({ name: def.name, schema: def.schema }));
      if (ephemeral.length > 0) primitives.push(tagGroupsFactory('ephemeral', ephemeral));
      if (persistent.length > 0) primitives.push(tagGroupsFactory('persistent', persistent));
    }

    if (config.errors && config.errors.length > 0) {
      // Each entry is either a built ErrorDefWithFactory from the core
      // `error()` factory (a function) or a plain ErrorContractDef shape
      // from contract-style declaration (has `_: 'error'`).
      collectUnique(config.errors as readonly { code: string }[], (e) => e.code, {
        kind: 'error code',
        context: 'contract()',
      });
      const errorDefs = config.errors.map((e: any) =>
        typeof e === 'function' ? e : makeRuntimeErrorDef(e.code, e.schema),
      );
      if (errorDefs.length > 0) {
        primitives.push(errorsFactory(...(errorDefs as [any, ...any[]])));
      }
    }

    // Push plugins ahead of lifecycle and definitions so their hooks register
    // first and run before user handlers.
    if (config.plugins && config.plugins.length > 0) {
      for (const mod of config.plugins) {
        primitives.push(mod as Primitive);
      }
    }

    if (this._bag.lifecycle.onUpgrade) primitives.push(onUpgrade(this._bag.lifecycle.onUpgrade));
    if (this._bag.lifecycle.onInit) primitives.push(onInit(this._bag.lifecycle.onInit));
    if (this._bag.lifecycle.onConnect) primitives.push(onConnect(this._bag.lifecycle.onConnect));
    if (this._bag.lifecycle.onDisconnect)
      primitives.push(onDisconnect(this._bag.lifecycle.onDisconnect));
    if (this._bag.lifecycle.onShutdown) primitives.push(onShutdown(this._bag.lifecycle.onShutdown));
    if (this._bag.lifecycle.onError) primitives.push(onError(this._bag.lifecycle.onError));
    if (this._bag.lifecycle.onValidationError)
      primitives.push(onValidationError(this._bag.lifecycle.onValidationError));

    if (this._bag.intercept) primitives.push(interceptFactory(this._bag.intercept));

    primitives.push(
      ...this._buildDefinitions(config.definitions, {
        incomingHandlers: this._bag.incomingHandlers,
        requestHandlers: this._bag.requestHandlers,
        streamGenerators: this._bag.streamGenerators,
        resumableStreamGenerators: this._bag.resumableStreamGenerators,
        recordedStreamGenerators: this._bag.recordedStreamGenerators,
        scheduledHandlers: this._bag.scheduledHandlers,
        channelImpls: this._bag.channelImpls,
      }),
    );

    return Object.freeze({
      __wskit: 'server' as const,
      primitives: Object.freeze(primitives) as readonly Primitive[],
      __features: Object.freeze(
        new Set(
          [
            config.ack ? 'ack' : undefined,
            config.replay === true || (typeof config.replay === 'object' && config.replay !== null)
              ? 'replay'
              : undefined,
            config.persistence ? 'persistence' : undefined,
            config.sequence ? 'sequence' : undefined,
            config.dedup ? 'dedup' : undefined,
            config.hibernation ? 'hibernation' : undefined,
            config.keepalive ? 'keepalive' : undefined,
          ].filter((feature): feature is string => feature !== undefined),
        ),
      ),
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
        default: {
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

function hasDurableStreamDef(defs: readonly Definition[]): boolean {
  for (const def of defs) {
    if (def._ === 'resumable-stream' || def._ === 'recorded-stream') return true;
    if (def._ === 'channel' && hasDurableStreamDef((def as ChannelDef).definitions)) return true;
  }
  return false;
}

// The contract-side `error(code, schema?)` shape is plain data; the engine's
// `errors()` primitive wants an ErrorDef with a callable factory.
function makeRuntimeErrorDef(code: string, schema?: any) {
  return schema ? coreErrorFactory(code, schema) : coreErrorFactory(code);
}
