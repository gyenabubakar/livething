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

type ConfigParameter = { input?: unknown; allowInterleaving?: boolean; run: any };

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
  recorded: 'recordedStream()',
} as const;

/**
 * The cross-capability builders a channel borrows so the channel module never
 * imports the stream or replay engines itself. `assemble`-time wiring fills
 * these from the capabilities the server actually lists, so a channels-only app
 * pays for neither.
 */
export interface ChannelDeps {
  /** Id of the `base` this channel is declared on. Read by `context.channel(...)`. */
  readonly baseId?: symbol;
  /** Stream builders by kind, present only for the stream capabilities that are listed. */
  readonly streamBuilders: {
    plain?: StreamBuild;
    recorded?: StreamBuild;
  };
  /** Replay builder, present only when `replay.history()`/`replay.snapshot()` is listed. */
  readonly buildReplay?: (replayConfig: unknown) => Primitive;
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
 * The channel object returned by `base.channel(...)`. Nothing changes it after it
 * is created. Its handler methods return a value carrying both the client-contract
 * type and a reference back to the channel. A handler value passed to `assemble()`
 * enables that handler; passing the channel itself only includes its configuration
 * and hooks.
 *
 * Stream and replay handlers delegate to the matching capability's
 * builder (passed in as `deps`), so a channel only pulls in those engines when
 * the app also lists `stream()` / `replay.history()` / etc.
 */
export class ChannelBuilder {
  /** Marks this value for `assemble()` to collect as a channel. @internal */
  readonly __livethingChannel = true as const;
  /** Self-reference, so a channel and its handlers resolve to the same channel. @internal */
  readonly __channel: ChannelBuilder = this;
  /** The channel's unique key (static name or family key). @internal */
  readonly __key: string;
  /** Id of the `base` this channel is declared on. @internal */
  readonly __baseId: symbol | undefined;
  /** The channel-level rate-limit rule, if the config set one. @internal */
  readonly __rateLimit?: RateLimitConfig;

  private readonly pattern: string | ReturnType<typeof scopeFactory>;
  /** The config and hooks. Handlers are not here: `assemble()` passes the ones it was given. */
  private readonly children: Primitive[] = [];
  private readonly deps: ChannelDeps;
  /** Capability kinds declared by this channel's own `capabilities` list. */
  private readonly capabilityKinds = new Set<string>();

  constructor(pattern: unknown, config: any, deps: ChannelDeps) {
    this.deps = deps;
    this.__baseId = deps.baseId;
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

    if (cfg.rateLimit !== undefined) this.__rateLimit = cfg.rateLimit as RateLimitConfig;
    if (cfg.membership !== undefined) {
      this.children.push(membershipMarker(cfg.membership === 'persistent'));
    }

    if (cfg.replay !== undefined) {
      const build = deps.buildReplay;
      if (!build) {
        throw new Error(
          `[livething] channel '${this.__key}' sets replay but no replay capability is ` +
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
    if (cfg.onSubscribe)
      this.children.push(onSubscribeFactory(withChannelCtx(cfg.onSubscribe) as any));
    if (cfg.onUnsubscribe)
      this.children.push(onUnsubscribeFactory(withChannelCtx(cfg.onUnsubscribe) as any));
    if (cfg.onSessionEnd)
      this.children.push(onSessionEndFactory(withChannelCtx(cfg.onSessionEnd) as any));

    if (cfg.intercept) this.children.push(interceptFactory(withChannelCtx(cfg.intercept) as any));
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

    return this.handlerValue(primitive, config);
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

    return this.handlerValue(primitive, config);
  }

  stream(event: string, config: any): ChannelHandlerValue {
    return this.delegateStream('plain', event, config);
  }

  recordedStream(event: string, config: any): ChannelHandlerValue {
    return this.delegateStream('recorded', event, config);
  }

  /** Build the channel primitive from its config, its hooks and the given handlers. @internal */
  __build(selectedHandlers: ReadonlySet<Primitive>): Primitive {
    const seenEvents = new Set<string>();
    for (const handler of selectedHandlers) {
      const { event } = handler as { event?: string };
      if (event === undefined) continue;

      if (seenEvents.has(event)) {
        throw new Error(
          `[livething] Duplicate event '${event}' on channel '${this.__key}' passed to ` +
            'assemble(). Two handlers use this name. Remove one or rename it.',
        );
      }

      seenEvents.add(event);
    }

    const primitive = channelFactory(
      this.pattern as any,
      ...([...this.children, ...selectedHandlers] as any[]),
    );
    (primitive as { __capabilityKinds?: ReadonlySet<string> }).__capabilityKinds =
      this.capabilityKinds;

    return primitive;
  }

  /** Borrow a stream capability's builder, adapting the generator to the channel ctx. */
  private delegateStream(
    kind: 'plain' | 'recorded',
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

    return this.handlerValue(primitive, config);
  }

  /** A handler's own `rateLimit` travels on its primitive, so `assemble()` reads it from there. */
  private handlerValue(primitive: Primitive, config: any): ChannelHandlerValue {
    if (config?.rateLimit !== undefined) {
      (primitive as { __rateLimit?: RateLimitConfig }).__rateLimit = config.rateLimit;
    }

    return { __channel: this, __handler: primitive };
  }
}

/** The value a channel handler returns — carries a reference to its channel. @internal */
export interface ChannelHandlerValue {
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
 * accessor. Channel membership is ephemeral by default (set `membership:
 * 'persistent'` on a channel to keep it across reconnects); channel streams need the matching stream
 * capability.
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
