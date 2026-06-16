/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { channel as channelFactory, scope as scopeFactory } from '~/channel/channel.ts';
import { adaptChannelContext } from '~/channel/ctx-adapter.ts';
import {
  check as checkFactory,
  commit as commitFactory,
  onSessionEnd as onSessionEndFactory,
  onSubscribe as onSubscribeFactory,
  onUnsubscribe as onUnsubscribeFactory,
  revalidate as revalidateFactory,
} from '~/channel/lifecycle.ts';
import { incoming as incomingFactory } from '~/incoming/incoming.ts';
import { intercept as interceptFactory } from '~/intercept/intercept.ts';
import { outgoing as outgoingFactory } from '~/outgoing/outgoing.ts';
import { persistentMarker } from '~/persistence/channel-marker.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';

/** Builds one stream primitive from a `(event, config)` pair. Supplied by a stream capability. */
type StreamBuild = (event: string, config: unknown) => Primitive;

/** The capability name a channel stream of each kind needs listed. */
const CHANNEL_STREAM_CAPABILITY = {
  plain: 'stream()',
  resumable: 'resumableStream()',
  recorded: 'recordedStream()',
} as const;

/**
 * The cross-capability builders a channel borrows so the channel module never
 * imports the stream or replay engines itself. `assemble`-time wiring fills
 * these from the capabilities the server actually lists, so a channels-only app
 * pays for neither.
 */
export interface ChannelDeps {
  /** Stream builders by kind, present only for the stream capabilities that are listed. */
  readonly streamBuilders: {
    plain?: StreamBuild;
    resumable?: StreamBuild;
    recorded?: StreamBuild;
  };
  /** Custom-replay builder, present only when `replay.custom()` is listed. */
  readonly buildCustomReplay?: (hooks: {
    beforeSend?: unknown;
    afterSend?: unknown;
    replay: unknown;
  }) => Primitive;
  /** Built-in replay builder, present only when `replay.history()`/`replay.snapshot()` is listed. */
  readonly buildBuiltinReplay?: (replayConfig: unknown) => Primitive;
  /** Request builder, present only when the `requests()` capability is listed. */
  readonly buildRequest?: (event: string, config: { input?: unknown; run: any }) => Primitive;
  /**
   * Merge a channel's own `outgoing.requests` declarations into the engine's
   * server→client request table. Present only when `requests()` is listed, so a
   * channel declaring `outgoing.requests` without it is a build error.
   */
  readonly registerServerRequests?: (decls: Record<string, any>) => void;
}

/** Compose the channel-context alias onto whatever a handler already adapts. */
function withChannelCtx(
  run: (ctx: any, payload: any) => unknown,
): (ctx: any, payload: any) => unknown {
  return (ctx, payload) => run(adaptChannelContext(ctx), payload);
}

/**
 * The accumulating channel object returned by `base.channel(...)`. Its handler
 * methods register onto the channel and return a value carrying both the
 * client-contract type and a reference back to the channel; its gate and
 * lifecycle methods mutate and return void. `assemble()` reaches the channel
 * through any of those values (or the channel itself) and builds it once.
 *
 * Stream and custom-replay handlers delegate to the matching capability's
 * builder (passed in as `deps`), so a channel only pulls in those engines when
 * the app also lists `stream()` / `replay.custom()` / etc.
 */
export class ChannelBuilder {
  /** Marks this value for `assemble()` to collect as a channel. @internal */
  readonly __wskitChannel = true as const;
  /** Self-reference, so a channel and its handlers resolve to the same channel. @internal */
  readonly __channel: ChannelBuilder = this;
  /** The channel's unique key (static name or family key). @internal */
  readonly __key: string;
  /** The channel-level rate-limit rule, if the config set one. @internal */
  readonly __rateLimit?: RateLimitConfig;
  /** Per-handler rate-limit overrides for this channel, keyed by event. @internal */
  readonly __rateLimitOverrides = new Map<string, RateLimitConfig>();

  private readonly pattern: string | ReturnType<typeof scopeFactory>;
  private readonly children: Primitive[] = [];
  private readonly once = new Set<string>();
  private readonly deps: ChannelDeps;

  constructor(pattern: unknown, config: any, deps: ChannelDeps) {
    this.deps = deps;
    if (Array.isArray(pattern)) {
      const [family, template] = pattern as [string, string];
      this.pattern = scopeFactory(family, template);
      this.__key = family;
    } else {
      this.pattern = pattern as string;
      this.__key = pattern as string;
    }

    const cfg = config ?? {};
    if (cfg.rateLimit) this.__rateLimit = cfg.rateLimit as RateLimitConfig;
    const emits = cfg.outgoing?.emits as Record<string, unknown> | undefined;
    if (emits) {
      for (const event of Object.keys(emits)) this.children.push(outgoingFactory(event));
    }
    const serverRequests = cfg.outgoing?.requests as Record<string, unknown> | undefined;
    if (serverRequests && Object.keys(serverRequests).length > 0) {
      const register = deps.registerServerRequests;
      if (!register) {
        throw new Error(
          `[wskit] channel '${this.__key}' declares outgoing.requests but the requests() ` +
            'capability is not listed. Add requests() to capabilities.',
        );
      }
      register(serverRequests);
    }
    if (cfg.persistent !== undefined) this.children.push(persistentMarker(cfg.persistent));
    if (cfg.replay !== undefined) {
      const build = deps.buildBuiltinReplay;
      if (!build) {
        throw new Error(
          `[wskit] channel '${this.__key}' sets replay but no built-in replay capability is ` +
            'listed. Add replay.history() or replay.snapshot() to capabilities.',
        );
      }
      this.children.push(build(cfg.replay));
    }
    if (cfg.check) {
      this.children.push(
        checkFactory(
          (ctx: any, data: unknown) => {
            (ctx as Record<PropertyKey, unknown>).check = data;
            return cfg.check(adaptChannelContext(ctx));
          },
          cfg.subscribe ? { validator: cfg.subscribe } : undefined,
        ),
      );
    }
    if (cfg.commit) this.children.push(commitFactory(withChannelCtx(cfg.commit) as any));
    if (cfg.revalidate)
      this.children.push(revalidateFactory(withChannelCtx(cfg.revalidate) as any));
  }

  on(event: string, config: any): ChannelHandlerValue {
    this.recordRateLimit(event, config);
    this.children.push(
      incomingFactory(
        event,
        withChannelCtx(config.run) as any,
        config.input ? { validator: config.input } : undefined,
      ),
    );
    return this.handlerValue();
  }

  request(event: string, config: any): ChannelHandlerValue {
    const build = this.deps.buildRequest;
    if (!build) {
      throw new Error(
        `[wskit] channel '${this.__key}' uses request() but the requests() capability is not ` +
          'listed. Add requests() to capabilities.',
      );
    }
    this.recordRateLimit(event, config);
    const run = config.run;
    this.children.push(
      build(event, {
        input: config.input,
        run: (ctx: any, payload: any) => run(adaptChannelContext(ctx), payload),
      }),
    );
    return this.handlerValue();
  }

  stream(event: string, config: any): ChannelHandlerValue {
    return this.delegateStream('plain', event, config);
  }

  resumableStream(event: string, config: any): ChannelHandlerValue {
    return this.delegateStream('resumable', event, config);
  }

  recordedStream(event: string, config: any): ChannelHandlerValue {
    return this.delegateStream('recorded', event, config);
  }

  subscribe(handler: (ctx: any) => void | Promise<void>): void {
    this.registerOnce('subscribe', onSubscribeFactory(withChannelCtx(handler) as any));
  }

  unsubscribe(handler: (ctx: any) => void | Promise<void>): void {
    this.registerOnce('unsubscribe', onUnsubscribeFactory(withChannelCtx(handler) as any));
  }

  sessionEnd(handler: (ctx: any) => void | Promise<void>): void {
    this.registerOnce('sessionEnd', onSessionEndFactory(withChannelCtx(handler) as any));
  }

  intercept(handler: (ctx: any, frame: any) => unknown): void {
    this.registerOnce('intercept', interceptFactory(withChannelCtx(handler) as any));
  }

  replay(hooks: { beforeSend?: any; afterSend?: any; replay: any }): void {
    const build = this.deps.buildCustomReplay;
    if (!build) {
      throw new Error(
        `[wskit] channel '${this.__key}' uses replay() but the replay.custom() capability is ` +
          'not listed. Add replay.custom() to capabilities.',
      );
    }
    this.registerOnce('replay', build(hooks));
  }

  /** Build the channel primitive from everything registered so far. @internal */
  __build(): Primitive {
    return channelFactory(this.pattern as any, ...(this.children as any[]));
  }

  /** Borrow a stream capability's builder, adapting the generator to the channel ctx. */
  private delegateStream(
    kind: 'plain' | 'resumable' | 'recorded',
    event: string,
    config: any,
  ): ChannelHandlerValue {
    const build = this.deps.streamBuilders[kind];
    if (!build) {
      const capabilityName = CHANNEL_STREAM_CAPABILITY[kind];
      throw new Error(
        `[wskit] channel '${this.__key}' uses ${capabilityName} but the ${capabilityName} ` +
          `capability is not listed. Add ${capabilityName} to capabilities.`,
      );
    }
    this.recordRateLimit(event, config);
    const run = config.run;
    const channelConfig = {
      ...config,
      run: (ctx: any, payload: any) => run(adaptChannelContext(ctx), payload),
    };
    this.children.push(build(event, channelConfig));
    return this.handlerValue();
  }

  /** Stash a handler's `rateLimit` override so assembly can fold it into the plan. */
  private recordRateLimit(event: string, config: any): void {
    if (config?.rateLimit) {
      this.__rateLimitOverrides.set(event, config.rateLimit as RateLimitConfig);
    }
  }

  private registerOnce(slot: string, primitive: Primitive): void {
    if (this.once.has(slot)) {
      throw new Error(
        `[wskit] Duplicate ${slot} on channel '${this.__key}'. Only one ${slot} can be attached.`,
      );
    }
    this.once.add(slot);
    this.children.push(primitive);
  }

  private handlerValue(): ChannelHandlerValue {
    return { __wskitChannelHandler: true, __channel: this };
  }
}

/** The value a channel handler returns — carries a reference to its channel. @internal */
export interface ChannelHandlerValue {
  readonly __wskitChannelHandler: true;
  readonly __channel: ChannelBuilder;
}

/** A `channels()` capability, carrying the factory that builds channel objects. */
export interface ChannelsCapability extends Capability<{}, never, 'channels'> {
  /** Build a channel object from a pattern, config, and the borrowed builders. @internal */
  readonly __channelFactory: (
    pattern: unknown,
    config: unknown,
    deps: ChannelDeps,
  ) => ChannelBuilder;
}

/**
 * Enable channels — subscription scopes with their own events, gates, and
 * lifecycle. Listing this grants `base.channel(...)` and the `ctx.channels`
 * accessor. Persistent membership additionally needs the `persistence()`
 * capability; channel streams need the matching stream capability, and a custom
 * channel replay needs `replay.custom()`.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { channels } from '@wskit/server/channels';
 * import * as v from 'valibot';
 *
 * const base = define({ env: t<Env>(), capabilities: [channels()] });
 *
 * const lobby = base.channel('lobby', { outgoing: { emits: { joined: t<{ id: string }>() } } });
 * export const handleChat = lobby.on('chat', {
 *   input: v.object({ text: v.string() }),
 *   run(ctx, input) { ctx.channel.broadcast('joined', { id: ctx.id }); },
 * });
 * ```
 */
export const channels = withCapabilityKind(function channels(): ChannelsCapability {
  const cap = capability<{}, never, 'channels'>([]) as ChannelsCapability;
  (cap as { __channelFactory: ChannelsCapability['__channelFactory'] }).__channelFactory = (
    pattern,
    config,
    deps,
  ) => new ChannelBuilder(pattern, config, deps);
  return stampKind(cap, CAPABILITY_KIND.channels);
}, CAPABILITY_KIND.channels);
