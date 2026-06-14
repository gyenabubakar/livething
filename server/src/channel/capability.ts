/* oxlint-disable @typescript-eslint/no-explicit-any */
import { capability } from '~/_define/capability.ts';
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
import { handleReplay as customReplayFactory } from '~/replay/custom/custom.ts';
import { replay as replayFactory } from '~/replay/replay.ts';
import { request as requestFactory } from '~/request/request.ts';
import { compileRecordedStreamDef } from '~/stream-recorded/compile.ts';
import { recordedStream as recordedStreamDef } from '~/stream-recorded/definition.ts';
import { compileResumableStreamDef } from '~/stream-resumable/compile.ts';
import { resumableStream as resumableStreamDef } from '~/stream-resumable/definition.ts';
import { toNudgeDefs, wrapStreamGenerator } from '~/stream/capability.ts';
import { compileStreamDef } from '~/stream/compile.ts';
import { stream as streamDef } from '~/stream/definition.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';

/** Compose the channel-context alias onto whatever a handler already adapts. */
function withChannelCtx(
  run: (ctx: any, payload: any) => unknown,
): (ctx: any, payload: any) => unknown {
  return (ctx, payload) => run(adaptChannelContext(ctx), payload);
}

/** Wrap a stream generator with both the stream handle and the channel alias. */
function wrapChannelStream(
  run: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>,
): (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown> {
  const streamWrapped = wrapStreamGenerator(run);
  return (ctx, payload) => streamWrapped(adaptChannelContext(ctx), payload);
}

/**
 * The accumulating channel object returned by `base.channel(...)`. Its handler
 * methods register onto the channel and return a value that carries both the
 * client-contract type and a reference back here; its lifecycle and gate methods
 * just mutate. `assemble()` reaches the channel through any of those values (or
 * the channel itself) and builds it once.
 */
export class ChannelBuilder {
  /** Marks this value for `assemble()` to collect as a channel. @internal */
  readonly __wskitChannel = true as const;
  /** Self-reference, so a channel and its handlers resolve to the same channel. @internal */
  readonly __channel: ChannelBuilder = this;
  /** The channel's unique key (static name or family key). @internal */
  readonly __key: string;

  private readonly pattern: string | ReturnType<typeof scopeFactory>;
  private readonly children: Primitive[] = [];
  private readonly once = new Set<string>();

  constructor(pattern: unknown, config: any) {
    if (Array.isArray(pattern)) {
      const [family, template] = pattern as [string, string];
      this.pattern = scopeFactory(family, template);
      this.__key = family;
    } else {
      this.pattern = pattern as string;
      this.__key = pattern as string;
    }

    const cfg = config ?? {};
    const emits = cfg.outgoing?.emits as Record<string, unknown> | undefined;
    if (emits) {
      for (const event of Object.keys(emits)) this.children.push(outgoingFactory(event));
    }
    if (cfg.persistent !== undefined) this.children.push(persistentMarker(cfg.persistent));
    if (cfg.replay !== undefined) this.children.push(buildBuiltinReplay(cfg.replay));
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
    const run = config.run;
    this.children.push(
      requestFactory(
        event,
        withChannelCtx(async (ctx: { respond(value: unknown): void }, payload: unknown) => {
          const result = await run(ctx, payload);
          if (result !== undefined && result !== null) ctx.respond(result);
        }) as any,
        config.input ? { validator: config.input } : undefined,
      ),
    );
    return this.handlerValue();
  }

  stream(event: string, config: any): ChannelHandlerValue {
    const def = streamDef(event, {
      payload: config.input,
      nudges: toNudgeDefs(config.nudges),
      broadcast: config.broadcast,
      allowConcurrent: config.allowConcurrent,
    });
    this.children.push(compileStreamDef(def, new Map([[event, wrapChannelStream(config.run)]])));
    return this.handlerValue();
  }

  resumableStream(event: string, config: any): ChannelHandlerValue {
    const cursor =
      config.cursor && (config.cursor as { __wskit_t?: unknown }).__wskit_t === 't'
        ? undefined
        : config.cursor;
    const def = resumableStreamDef(event, {
      payload: config.input,
      cursor,
      nudges: toNudgeDefs(config.nudges),
      broadcast: config.broadcast,
      allowConcurrent: config.allowConcurrent,
      onDisconnect: config.onDisconnect,
      maxChunks: config.maxChunks,
      maxAgeMs: config.maxAgeMs,
      retentionAfterEndMs: config.retentionAfterEndMs,
    });
    this.children.push(
      compileResumableStreamDef(def, new Map([[event, wrapChannelStream(config.run)]])),
    );
    return this.handlerValue();
  }

  recordedStream(event: string, config: any): ChannelHandlerValue {
    const def = recordedStreamDef(event, {
      payload: config.input,
      nudges: toNudgeDefs(config.nudges),
      broadcast: config.broadcast,
      allowConcurrent: config.allowConcurrent,
      onDisconnect: config.onDisconnect,
      maxChunks: config.maxChunks,
      maxAgeMs: config.maxAgeMs,
      retentionAfterEndMs: config.retentionAfterEndMs,
    });
    this.children.push(
      compileRecordedStreamDef(def, new Map([[event, wrapChannelStream(config.run)]])),
    );
    return this.handlerValue();
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
    this.registerOnce(
      'replay',
      customReplayFactory({
        onBeforeSend: hooks.beforeSend,
        onAfterSend: hooks.afterSend,
        onReplay: hooks.replay,
      }),
    );
  }

  /** Build the channel primitive from everything registered so far. @internal */
  __build(): Primitive {
    return channelFactory(this.pattern as any, ...(this.children as any[]));
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

/** Build the built-in channel replay primitive from the cascade flag/config. */
function buildBuiltinReplay(replay: unknown): Primitive {
  if (replay === false) return replayFactory(false);
  if (replay === true) return replayFactory();
  return replayFactory(replay as any);
}

/** A `channels()` capability, carrying the factory that builds channel objects. */
export interface ChannelsCapability extends Capability<{}, never, 'channels'> {
  /** Build a channel object from a pattern and config. @internal */
  readonly __channelFactory: (pattern: unknown, config: unknown) => ChannelBuilder;
}

/**
 * Enable channels — subscription scopes with their own events, gates, and
 * lifecycle. Listing this grants `base.channel(...)` and the `ctx.channels`
 * accessor. Persistent membership additionally needs the `persistence()`
 * capability.
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
export function channels(): ChannelsCapability {
  const cap = capability<{}, never, 'channels'>([]) as ChannelsCapability;
  (cap as { __channelFactory: ChannelsCapability['__channelFactory'] }).__channelFactory = (
    pattern,
    config,
  ) => new ChannelBuilder(pattern, config);
  return cap;
}
