/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertUniqueCapabilityKinds } from '~/_define/capability-checks.ts';
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
import { membershipMarker } from '~/channel/marker.ts';
import { channelRuntimePrimitive } from '~/channel/service.ts';
import { fillChannelTemplate } from '~/channel/template.ts';
import { incoming as incomingFactory } from '~/incoming/incoming.ts';
import { intercept as interceptFactory } from '~/intercept/intercept.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';

type HooksParameter = {
  beforeBroadcast?: unknown;
  afterBroadcast?: unknown;
  replay: unknown;
};
type ConfigParameter = { input?: unknown; allowInterleaving?: boolean; run: any };
type HooksParameter2 = { beforeBroadcast?: any; afterBroadcast?: any; replay: any };

/** Builds one stream primitive from a `(event, config)` pair. Supplied by a stream capability. */
type StreamBuild = (event: string, config: unknown) => Primitive;

/**
 * The seam every channel-only capability (`inbox()`, `readReceipts()`, and any
 * future one) attaches onto itself so `ChannelBuilder` can pull its primitive
 * out of the channel's own `capabilities` list, and read its declared identity,
 * without importing that capability's engine or knowing its name. @internal
 */
interface ChannelOnlyBuilder {
  readonly __capabilityKind?: string;
  readonly __primitives: readonly Primitive[];
  __buildChannelPrimitive?: () => Primitive;
  readonly __channelEmits?: Record<string, unknown>;
  readonly __channelServerRequests?: Record<string, unknown>;
}

/** The capability name a channel stream of each kind needs listed. */
const CHANNEL_STREAM_CAPABILITY = {
  plain: 'stream()',
  cursor: 'cursorStream()',
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
    cursor?: StreamBuild;
    recorded?: StreamBuild;
  };
  /** Custom-replay builder, present only when `replay.custom()` is listed. */
  readonly buildCustomReplay?: (hooks: HooksParameter) => Primitive;
  /** Built-in replay builder, present only when `replay.history()`/`replay.snapshot()` is listed. */
  readonly buildBuiltinReplay?: (replayConfig: unknown) => Primitive;
  /** Request builder, present only when the `clientRequests()` capability is listed. */
  readonly buildClientRequest?: (event: string, config: ConfigParameter) => Primitive;
  /**
   * Merge channel `serverRequests(...)` declarations into the server→client
   * request table. Present only when `serverRequests()` is listed at the root.
   */
  readonly registerServerRequests?: (channelKey: string, declarations: Record<string, any>) => void;
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
 * lifecycle methods mutate and return void. A handler value passed to
 * `assemble()` enables that handler; passing the channel itself only includes
 * its configuration and lifecycle behavior.
 *
 * Stream and custom-replay handlers delegate to the matching capability's
 * builder (passed in as `deps`), so a channel only pulls in those engines when
 * the app also lists `stream()` / `replay.custom()` / etc.
 */
export class ChannelBuilder {
  /** Marks this value for `assemble()` to collect as a channel. @internal */
  readonly __livethingChannel = true as const;
  /** Self-reference, so a channel and its handlers resolve to the same channel. @internal */
  readonly __channel: ChannelBuilder = this;
  /** The channel's unique key (static name or family key). @internal */
  readonly __key: string;
  /** The channel-level rate-limit rule, if the config set one. @internal */
  readonly __rateLimit?: RateLimitConfig;
  /** Per-handler rate-limit overrides for this channel. @internal */
  readonly __rateLimitOverrides = new Map<Primitive, { event: string; config: RateLimitConfig }>();

  private readonly pattern: string | ReturnType<typeof scopeFactory>;
  private readonly children: Primitive[] = [];
  private readonly handlerPrimitives = new Set<Primitive>();
  private readonly once = new Set<string>();
  private readonly deps: ChannelDeps;
  /** Capability kinds declared by this channel's own `capabilities` list. */
  private readonly capabilityKinds = new Set<string>();

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
    assertUniqueCapabilityKinds(
      (cfg.capabilities as readonly Capability[] | undefined) ?? [],
      `channel '${this.__key}' capabilities`,
    );

    if (cfg.rateLimit) this.__rateLimit = cfg.rateLimit as RateLimitConfig;
    if (cfg.membership !== undefined) {
      this.children.push(membershipMarker(cfg.membership === 'persistent'));
    }

    if (cfg.replay !== undefined) {
      const build = deps.buildBuiltinReplay;
      if (!build) {
        throw new Error(
          `[livething] channel '${this.__key}' sets replay but no built-in replay capability is ` +
            'listed. Add replay.history() or replay.snapshot() to capabilities.',
        );
      }

      this.children.push(build(cfg.replay));
    }

    for (const cap of (cfg.capabilities as readonly ChannelOnlyBuilder[] | undefined) ?? []) {
      if (cap.__capabilityKind) this.capabilityKinds.add(cap.__capabilityKind);
      if (cap.__channelEmits) this.children.push(...cap.__primitives);
      if (cap.__channelServerRequests && Object.keys(cap.__channelServerRequests).length > 0) {
        const register = deps.registerServerRequests;
        if (!register) {
          throw new Error(
            `[livething] channel '${this.__key}' declares serverRequests(...) but serverRequests() ` +
              'is not listed. Add serverRequests() to capabilities.',
          );
        }

        register(this.__key, cap.__channelServerRequests);
      }

      if (cap.__buildChannelPrimitive) this.children.push(cap.__buildChannelPrimitive());
    }

    if (cfg.check) {
      this.children.push(
        checkFactory(
          (ctx: any, data: unknown) => cfg.check(adaptChannelContext(ctx), data),
          cfg.subscribe ? { validator: cfg.subscribe } : undefined,
        ),
      );
    } else if (cfg.subscribe) {
      this.children.push(checkFactory(() => undefined, { validator: cfg.subscribe }));
    }

    if (cfg.commit) this.children.push(commitFactory(withChannelCtx(cfg.commit) as any));
    if (cfg.revalidate)
      this.children.push(revalidateFactory(withChannelCtx(cfg.revalidate) as any));
  }

  /**
   * Resolve a dynamic family to a concrete instance ref for `ctx.channels.get(...)`.
   * Fills the family template with `params` (e.g. `room:{id}` + `{ id: 'abc' }`
   * → `room:abc`). Only valid on a family channel; a static channel throws.
   */
  at(params: Record<string, string>): ChannelRefValue {
    if (typeof this.pattern === 'string') {
      throw new Error(
        `[livething] .at(...) is only available on dynamic family channels; '${this.__key}' is a ` +
          'static channel — pass it to ctx.channels.get(...) directly.',
      );
    }

    const name = fillChannelTemplate(this.pattern.template, params, `channel '${this.__key}'`);
    return { __livethingChannelRef: true, family: this.__key, name };
  }

  on(event: string, config: any): ChannelHandlerValue {
    const primitive = incomingFactory(event, withChannelCtx(config.run) as any, {
      validator: config.input,
      allowInterleaving: config.allowInterleaving,
    });
    this.recordRateLimit(event, config, primitive);
    this.handlerPrimitives.add(primitive);
    this.children.push(primitive);

    return this.handlerValue(primitive);
  }

  request(event: string, config: any): ChannelHandlerValue {
    const build = this.deps.buildClientRequest;
    if (!build) {
      throw new Error(
        `[livething] channel '${this.__key}' uses request() but clientRequests() is not ` +
          'listed. Add clientRequests() to capabilities.',
      );
    }

    const run = config.run;
    const primitive = build(event, {
      input: config.input,
      allowInterleaving: config.allowInterleaving,
      run: (ctx: any, payload: any) => run(adaptChannelContext(ctx), payload),
    });
    this.recordRateLimit(event, config, primitive);

    this.handlerPrimitives.add(primitive);
    this.children.push(primitive);

    return this.handlerValue(primitive);
  }

  stream(event: string, config: any): ChannelHandlerValue {
    return this.delegateStream('plain', event, config);
  }

  cursorStream(event: string, config: any): ChannelHandlerValue {
    return this.delegateStream('cursor', event, config);
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

  replay(hooks: HooksParameter2): void {
    const build = this.deps.buildCustomReplay;
    if (!build) {
      throw new Error(
        `[livething] channel '${this.__key}' uses replay() but the replay.custom() capability is ` +
          'not listed. Add replay.custom() to capabilities.',
      );
    }

    this.registerOnce('replay', build(hooks));
  }

  /** Build the channel primitive from everything registered so far. @internal */
  __build(selectedHandlers?: ReadonlySet<Primitive>): Primitive {
    const children = selectedHandlers
      ? this.children.filter(
          (child) => !this.handlerPrimitives.has(child) || selectedHandlers.has(child),
        )
      : this.children;
    const primitive = channelFactory(this.pattern as any, ...(children as any[]));
    (primitive as { __capabilityKinds?: ReadonlySet<string> }).__capabilityKinds =
      this.capabilityKinds;
    return primitive;
  }

  /** Borrow a stream capability's builder, adapting the generator to the channel ctx. */
  private delegateStream(
    kind: 'plain' | 'cursor' | 'recorded',
    event: string,
    config: any,
  ): ChannelHandlerValue {
    const build = this.deps.streamBuilders[kind];
    if (!build) {
      const capabilityName = CHANNEL_STREAM_CAPABILITY[kind];
      throw new Error(
        `[livething] channel '${this.__key}' uses ${capabilityName} but the ${capabilityName} ` +
          `capability is not listed. Add ${capabilityName} to capabilities.`,
      );
    }

    const run = config.run;
    const channelConfig = {
      ...config,
      run: (ctx: any, payload: any) => run(adaptChannelContext(ctx), payload),
    };

    const primitive = build(event, channelConfig);

    this.recordRateLimit(event, config, primitive);
    this.handlerPrimitives.add(primitive);
    this.children.push(primitive);

    return this.handlerValue(primitive);
  }

  /** Stash a handler's `rateLimit` override so assembly can fold it into the plan. */
  private recordRateLimit(event: string, config: any, primitive: Primitive): void {
    if (config?.rateLimit) {
      this.__rateLimitOverrides.set(primitive, {
        event,
        config: config.rateLimit as RateLimitConfig,
      });
    }
  }

  private registerOnce(slot: string, primitive: Primitive): void {
    if (this.once.has(slot)) {
      throw new Error(
        `[livething] Duplicate ${slot} on channel '${this.__key}'. Only one ${slot} can be attached.`,
      );
    }

    this.once.add(slot);
    this.children.push(primitive);
  }

  private handlerValue(primitive: Primitive): ChannelHandlerValue {
    return { __livethingChannelHandler: true, __channel: this, __handler: primitive };
  }
}

/** The value a channel handler returns — carries a reference to its channel. @internal */
export interface ChannelHandlerValue {
  readonly __livethingChannelHandler: true;
  readonly __channel: ChannelBuilder;
  readonly __handler: Primitive;
}

/**
 * A resolved channel-instance reference produced by a family declaration's `.at(params)`.
 * `ctx.channels.get(ref)` reads it to address one channel; the public typed shape
 * is `ChannelRef` (it carries the channel's emit + request contract). @internal
 */
export interface ChannelRefValue {
  readonly __livethingChannelRef: true;
  readonly family: string;
  readonly name: string;
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
 * accessor. Channel membership is durable by default (set `membership:
 * 'ephemeral'` on a channel to opt out); channel streams need the matching stream
 * capability, and a custom channel replay needs `replay.custom()`.
 *
 * @example
 * ```ts
 * import { server, emits, t } from '@livething/server';
 * import { channels } from '@livething/server/channels';
 * import * as v from 'valibot';
 *
 * const base = server({ capabilities: [channels()] });
 *
 * const lobby = base.channel('lobby', { capabilities: [emits({ joined: t<{ id: string }>() })] });
 * export const handleChat = lobby.on('chat', {
 *   input: v.object({ text: v.string() }),
 *   run(ctx, input) { ctx.channel.broadcast('joined', { id: ctx.connection.id }); },
 * });
 *
 * export const server = base.assemble({ handlers: [handleChat] });
 * ```
 */
export const channels = withCapabilityKind(function channels(): ChannelsCapability {
  const cap = capability<{}, never, 'channels'>([channelRuntimePrimitive()]) as ChannelsCapability;
  (cap as { __channelFactory: ChannelsCapability['__channelFactory'] }).__channelFactory = (
    pattern,
    config,
    deps,
  ) => new ChannelBuilder(pattern, config, deps);
  return stampKind(cap, CAPABILITY_KIND.channels);
}, CAPABILITY_KIND.channels);
