/* oxlint-disable @typescript-eslint/no-explicit-any */
/* oxlint-disable eslint-plugin-import(no-cycle) */

import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/types.ts';
import {
  assertReplayScopeServable,
  isChannelReplayAuthorized,
  matchesReplayScope,
  readReplayContextScope,
  shouldStoreReplayMessage,
} from '~/replay/runtime.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { RuntimeConnection, WireOutgoingMessage } from '~/_engine/runtime/types.ts';
import type { KVProvider, Logger, SQLProvider } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReplayWire } from '../wire.ts';

/**
 * Discriminates the scope a `CustomReplayPrimitive` or its context operates in.
 * - `'top'` — top-level connection scope.
 * - `'channel'` — inside a channel scope.
 */
export type CustomReplayScope = 'top' | 'channel';

/**
 * Metadata attached to every outgoing message a top-level `replayCustom()`
 * primitive observes. Your `onBeforeSend` / `onAfterSend` hooks receive
 * this as `message.wire`. Use `seq` as a replay cursor and `messageId` as
 * a storage key.
 *
 * Top-level custom replay also observes channel-scoped messages by default
 * (the cascade behavior). When a message originated inside a channel, the
 * `channel` field is the concrete channel name; otherwise it is `null`.
 * When the channel is a dynamic family, `channelScope` is the family key;
 * otherwise it is `null`. Persist both alongside the row so a later
 * `onReplay(...)` can filter accurately.
 */
export interface TopLevelOutgoingWire {
  /** A monotonically increasing sequence number, unique per connection. */
  readonly seq: number;
  /** A unique ID for this message. */
  readonly messageId: string;
  /**
   * Concrete channel name when the message was sent inside a channel,
   * `null` for true top-level messages. Use this together with
   * `channelScope` as the storage key when persisting channel rows.
   */
  readonly channel: string | null;
  /**
   * Family key (matching `scope(key, pattern)`) for dynamic channels,
   * `null` for static channels and for true top-level messages. Read this
   * with a null-guard.
   */
  readonly channelScope: string | null;
}

/**
 * Wire metadata for messages observed by a channel-level `replayCustom()`
 * primitive. The primitive only sees messages from its own channel scope,
 * so `channel` is always populated.
 */
export interface ChannelOutgoingWire extends TopLevelOutgoingWire {
  /** The channel name the message was sent on. Always present. */
  readonly channel: string;
}

/**
 * Resolves to `ChannelOutgoingWire` for channel-scoped primitives and to
 * `TopLevelOutgoingWire` for top-level primitives.
 */
export type OutgoingWire<TScope extends CustomReplayScope> = TScope extends 'channel'
  ? ChannelOutgoingWire
  : TopLevelOutgoingWire;

/**
 * A single outgoing message delivered to `onBeforeSend` and `onAfterSend`.
 * Contains the event name, the clean application payload, and a `wire` object
 * you can use as a storage key and replay cursor.
 */
export interface OutgoingWireMessage<TScope extends CustomReplayScope = 'top'> {
  /** The event name. */
  readonly event: string;
  /** The application payload. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Metadata — sequence number, message ID, and for channels, channel info. */
  readonly wire: OutgoingWire<TScope>;
}

/**
 * The context passed to `onBeforeSend` and `onAfterSend` hooks. Provides
 * storage and platform access so hooks can persist messages without resorting
 * to module-scoped variable hacks.
 */
export interface CustomReplaySendContext {
  /** SQL access for persisting messages to your own replay store. */
  readonly sql: SQLProvider;
  /** KV access for persisting messages to your own replay store. */
  readonly kv: KVProvider;
  /** Environment variables / bindings available to the handler. */
  readonly env: Record<string, unknown>;
  /** Structured logger. */
  readonly log: Logger;
  /** Platform-specific context (e.g. the Cloudflare `DurableObjectState`). */
  readonly platform: unknown;
  /** The per-connection metadata from `onUpgrade`. */
  readonly meta: Record<string, unknown>;
}

/** Shared context fields available in all `onReplay` handler contexts. */
interface BaseCustomReplayContext {
  /** The connection ID of the client that requested replay. */
  readonly id: string;
  /** The per-connection metadata from `onUpgrade`. */
  readonly meta: Record<string, unknown>;
  /** SQL access for querying your own replay store. */
  readonly sql: SQLProvider;
  /** KV access for querying your own replay store. */
  readonly kv: KVProvider;
  /** Environment variables / bindings available to the handler. */
  readonly env: Record<string, unknown>;
  /** Structured logger. */
  readonly log: Logger;
  /** Platform-specific context (e.g. the Cloudflare `DurableObjectState`). */
  readonly platform: unknown;
  /** Schedule a promise to run after the handler returns. */
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The context passed to `onReplay` at the top-level connection scope. Provides
 * `sendReplay()` for re-sending stored messages to the reconnecting client.
 *
 * `request.channel` is the concrete channel name when the client's `_replay`
 * frame was scoped to a channel, otherwise `null`. `request.channelScope` is
 * the family key for dynamic channels, `null` for static channels and for
 * unscoped replay requests. Read both with null-guards. Use them to filter
 * persisted rows when serving replay back.
 */
export interface TopLevelReplayContext extends BaseCustomReplayContext {
  /** Routing markers from the client's `_replay` frame. */
  readonly request: {
    /** Channel name from `_channel` on the request, or `null`. */
    readonly channel: string | null;
    /** Family key from `_channelScope` on the request, or `null`. */
    readonly channelScope: string | null;
  };
  /**
   * Send one previously stored message to the reconnecting client.
   *
   * @param event   The original event name.
   * @param payload The original application payload.
   * @param wire    The original wire metadata (seq, messageId, channel).
   */
  sendReplay(event: string, payload: Record<string, unknown>, wire: ReplayWire): void;
}

/**
 * The context passed to `onReplay` inside a channel scope. Extends the
 * top-level context with `channel.name`.
 */
export interface ChannelReplayContext extends BaseCustomReplayContext {
  /** The channel this replay is scoped to. */
  readonly channel: { readonly name: string };
  /**
   * Send one previously stored message to the reconnecting client.
   */
  sendReplay(event: string, payload: Record<string, unknown>, wire: ReplayWire): void;
}

/**
 * Resolves to `ChannelReplayContext` for channel-scoped primitives and
 * `TopLevelReplayContext` for top-level primitives.
 */
export type ReplayContext<TScope extends CustomReplayScope> = TScope extends 'channel'
  ? ChannelReplayContext
  : TopLevelReplayContext;

/**
 * Hooks that describe a custom replay strategy: how outgoing messages get
 * persisted (via `onBeforeSend` or `onAfterSend`) and how they get replayed
 * back to a reconnecting client (via `onReplay`). Implement this instead of
 * the built-in `replay()` when you need custom storage — e.g. a third-party
 * database, a message broker, or cross-region replication.
 *
 * All three hooks are optional except `onReplay`, which is required to re-send
 * stored messages on reconnect.
 *
 * Beginner mental model:
 * - `onBeforeSend` or `onAfterSend` writes messages into your store
 * - `onReplay` reads those messages later and calls `ctx.sendReplay(...)`
 */
export interface CustomReplayOptions<TScope extends CustomReplayScope = 'top'> {
  /**
   * Called synchronously before each outgoing message is sent. Store the
   * message here for "store-before-send" (strict) durability.
   *
   * @param ctx     Storage and platform access (sql, kv, env, log, platform).
   * @param message The outgoing message with clean payload and wire metadata.
   */
  readonly onBeforeSend?: (
    ctx: CustomReplaySendContext,
    message: OutgoingWireMessage<TScope>,
  ) => void;

  /**
   * Called (optionally async) after each outgoing message is sent. Store the
   * message here for "store-after-send" (best-effort) durability.
   *
   * @param ctx     Storage and platform access (sql, kv, env, log, platform).
   * @param message The outgoing message with clean payload and wire metadata.
   */
  readonly onAfterSend?: (
    ctx: CustomReplaySendContext,
    message: OutgoingWireMessage<TScope>,
  ) => void | Promise<void>;

  /**
   * Called when a client sends the `_replay` protocol message. Query your own
   * store for all messages since `since` and call `ctx.sendReplay()` for each.
   *
   * @param ctx   The replay context with `sendReplay()` and storage access.
   * @param since The sequence number of the last message the client received.
   */
  readonly onReplay: (ctx: ReplayContext<TScope>, since: number) => void | Promise<void>;
}

/** The primitive type produced by `handleReplay()`. */
export interface CustomReplayPrimitive<
  TScope extends CustomReplayScope = CustomReplayScope,
> extends Primitive<'replayCustom'> {
  /** The configured replay hooks. */
  readonly options: CustomReplayOptions<TScope>;
}

const CUSTOM_REPLAY_KEY = Symbol('custom-replay');

/**
 * Shape one outgoing wire message into the `OutgoingWireMessage<'top'>` the
 * developer's `onBeforeSend` / `onAfterSend` hooks receive. The wire metadata
 * comes from the frame's `__wskit`; the payload is already pure user data.
 */
function toTopLevelWireMessage(message: WireOutgoingMessage): OutgoingWireMessage<'top'> {
  return {
    event: message.event,
    payload: message.payload,
    wire: {
      seq: Number(message.wskit.seq),
      messageId: String(message.wskit.messageId),
      channel: typeof message.wskit.channel === 'string' ? message.wskit.channel : null,
      channelScope:
        typeof message.wskit.channelScope === 'string' ? message.wskit.channelScope : null,
    },
  };
}

/**
 * Same as `toTopLevelWireMessage` but for channel-scoped messages — `channel`
 * is always present.
 */
function toChannelWireMessage(message: WireOutgoingMessage): OutgoingWireMessage<'channel'> {
  return {
    event: message.event,
    payload: message.payload,
    wire: {
      seq: Number(message.wskit.seq),
      messageId: String(message.wskit.messageId),
      channel: String(message.wskit.channel),
      channelScope:
        typeof message.wskit.channelScope === 'string' ? message.wskit.channelScope : null,
    },
  };
}

/**
 * Build the `TopLevelReplayContext` passed to the developer's `onReplay` hook
 * at the top-level connection scope.
 */
function createTopLevelReplayContext(
  engine: EngineAccess,
  baseCtx: Record<PropertyKey, unknown>,
  request: { channel: string | null; channelScope: string | null },
): TopLevelReplayContext {
  return {
    id: String(baseCtx.id),
    meta: (baseCtx.meta as Record<string, unknown>) ?? {},
    sql: baseCtx.sql as SQLProvider,
    kv: baseCtx.kv as KVProvider,
    env: (baseCtx.env as Record<string, unknown>) ?? {},
    log: baseCtx.log as Logger,
    platform: baseCtx.platform,
    waitUntil: baseCtx.waitUntil as (promise: Promise<unknown>) => void,
    request,
    sendReplay(event, payload, wire) {
      engine.assertReplaySendContract(event, payload, {
        channel: wire.channel,
        channelScope: wire.channelScope,
      });
      engine.sendReplay(
        String(baseCtx.id),
        wire.channel ?? null,
        wire.channelScope ?? null,
        event,
        payload,
        wire,
      );
    },
  };
}

/**
 * Build the `ChannelReplayContext` passed to the developer's `onReplay` hook
 * when the `_replay` request targets a specific channel.
 */
function createChannelReplayContext(
  engine: EngineAccess,
  baseCtx: Record<PropertyKey, unknown>,
  channelName: string,
  channelScope: string | null,
): ChannelReplayContext {
  return {
    id: String(baseCtx.id),
    meta: (baseCtx.meta as Record<string, unknown>) ?? {},
    channel: { name: channelName },
    sql: baseCtx.sql as SQLProvider,
    kv: baseCtx.kv as KVProvider,
    env: (baseCtx.env as Record<string, unknown>) ?? {},
    log: baseCtx.log as Logger,
    platform: baseCtx.platform,
    waitUntil: baseCtx.waitUntil as (promise: Promise<unknown>) => void,
    sendReplay(event, payload, wire) {
      engine.assertReplaySendContract(event, payload, {
        channel: channelName,
        channelScope,
      });
      engine.sendReplay(String(baseCtx.id), channelName, channelScope, event, payload, wire);
    },
  };
}

/**
 * @internal
 *
 * Internal primitive factory that powers `.replayCustom()`. It wires the
 * configured hooks into the engine's outgoing pipeline and `_replay` protocol
 * handler. This is not part of the public API — use the `.replayCustom()`
 * builder instead.
 *
 * @param options The three lifecycle hooks for storing and replaying messages.
 */
export function handleReplay<TScope extends CustomReplayScope = 'top'>(
  options: CustomReplayOptions<TScope>,
): CustomReplayPrimitive<TScope> {
  const opts = options as CustomReplayOptions<CustomReplayScope>;

  return {
    __wskit: 'replayCustom',
    __kind: 'infrastructure',
    __identity: [CUSTOM_REPLAY_KEY],
    __requires: {},
    options,
    __setup(engine: EngineAccess) {
      const { channelKey } = engine.getScopeInfo();

      let baseSendCtx: Omit<CustomReplaySendContext, 'meta'> | null = null;

      if (opts.onBeforeSend || opts.onAfterSend) {
        engine.onInit((ctx) => {
          const base = ctx as Record<PropertyKey, unknown>;
          baseSendCtx = {
            sql: base.sql as SQLProvider,
            kv: base.kv as KVProvider,
            env: (base.env as Record<string, unknown>) ?? {},
            log: base.log as Logger,
            platform: base.platform,
          };
        });
      }

      function buildSendCtx(meta: Record<string, unknown>): CustomReplaySendContext {
        return { ...baseSendCtx!, meta };
      }

      if (opts.onBeforeSend) {
        engine.onBeforeSend((message) => {
          if (
            !shouldStoreReplayMessage(
              channelKey,
              message.event,
              message.wskit,
              new Set(),
              engine.getReplayClaimedChannelKeys(),
            )
          )
            return;
          opts.onBeforeSend!(
            buildSendCtx(message.meta),
            channelKey
              ? (toChannelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>)
              : (toTopLevelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>),
          );
        });
      }

      if (opts.onAfterSend) {
        engine.onAfterSend((message) => {
          if (
            !shouldStoreReplayMessage(
              channelKey,
              message.event,
              message.wskit,
              new Set(),
              engine.getReplayClaimedChannelKeys(),
            )
          )
            return;
          return opts.onAfterSend!(
            buildSendCtx(message.meta),
            channelKey
              ? (toChannelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>)
              : (toTopLevelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>),
          );
        });
      }

      engine.onProtocolMessage('__replay__', async (ctx, frame) => {
        if (frame.event !== '__replay__') return false;
        const baseCtx = ctx as Record<PropertyKey, unknown>;
        const scope = readReplayContextScope(baseCtx);

        // Only handle the replay request if it matches this primitive's scope
        // (top-level vs. the correct channel).
        if (!matchesReplayScope(channelKey, scope, engine.getReplayClaimedChannelKeys())) {
          return false;
        }

        const connection = baseCtx[ENGINE_INTERNAL_CONNECTION] as RuntimeConnection | undefined;
        // Channel-scoped replay requests must verify membership. Otherwise any
        // connected client could harvest a channel's history with one frame.
        if (!isChannelReplayAuthorized(connection, scope, frame.__wskit)) {
          return true;
        }

        assertReplayScopeServable(channelKey, scope);

        const since = frame.payload.lastKnownSeq ?? 0;

        if (channelKey && scope.channelName) {
          await opts.onReplay(
            createChannelReplayContext(
              engine,
              baseCtx,
              scope.channelName,
              frame.__wskit.channelScope ?? null,
            ) as ReplayContext<CustomReplayScope>,
            since,
          );
          return true;
        }

        await opts.onReplay(
          createTopLevelReplayContext(engine, baseCtx, {
            channel: frame.__wskit.channel ?? null,
            channelScope: frame.__wskit.channelScope ?? null,
          }) as ReplayContext<CustomReplayScope>,
          since,
        );
        return true;
      });
    },
  } as CustomReplayPrimitive<TScope>;
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
handleReplay.__key = CUSTOM_REPLAY_KEY;
