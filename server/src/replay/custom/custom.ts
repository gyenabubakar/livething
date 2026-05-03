/* oxlint-disable @typescript-eslint/no-explicit-any */
/* oxlint-disable eslint-plugin-import(no-cycle) */

import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/types.ts';
import { dedup } from '~/dedup/dedup.ts';
import {
  isChannelReplayAuthorized,
  matchesReplayScope,
  readReplayContextScope,
  shouldStoreReplayMessage,
} from '~/replay/runtime.ts';
import { sequence } from '~/sequence/sequence.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ReplayWire } from '~/_types/scope-state';
import type { KVProvider, Logger, SQLProvider } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';

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
 * Converts a raw internal outgoing message (which still has `_seq`,
 * `_messageId`, etc. on the payload) into the clean `OutgoingWireMessage<'top'>`
 * shape that the developer's `onBeforeSend` / `onAfterSend` hooks receive.
 *
 * Uses JSON round-trip to produce a completely plain object — no prototype chain,
 * no undefined values, no references to internal data.
 */
function toTopLevelWireMessage(message: {
  event: string;
  payload: Record<string, unknown>;
}): OutgoingWireMessage<'top'> {
  const channel = typeof message.payload._channel === 'string' ? message.payload._channel : null;
  const channelScope =
    typeof message.payload._channelScope === 'string' ? message.payload._channelScope : null;
  // JSON.stringify drops undefined values; encode + decode preserves the
  // explicit nulls so consumers always see channel/channelScope keys.
  const stringified = JSON.stringify({
    event: message.event,
    payload: Object.fromEntries(
      Object.entries(message.payload).filter(([key]) => !key.startsWith('_')),
    ),
    wire: {
      seq: message.payload._seq,
      messageId: message.payload._messageId,
      channel,
      channelScope,
    },
  });
  const parsed = JSON.parse(stringified) as OutgoingWireMessage<'top'> & {
    wire: { channel: string | null; channelScope: string | null };
  };
  parsed.wire.channel = channel;
  parsed.wire.channelScope = channelScope;
  return parsed;
}

/**
 * Same as `toTopLevelWireMessage` but for channel-scoped messages. Adds
 * `channel` and `channelScope` to the `wire` object from the internal payload.
 */
function toChannelWireMessage(message: {
  event: string;
  payload: Record<string, unknown>;
}): OutgoingWireMessage<'channel'> {
  // JSON.stringify drops `undefined` values; force the explicit `null` so
  // static-channel messages keep `channelScope: null` after the round-trip
  // instead of dropping the key entirely.
  const channelScope =
    typeof message.payload._channelScope === 'string' ? message.payload._channelScope : null;
  const stringified = JSON.stringify({
    event: message.event,
    payload: Object.fromEntries(
      Object.entries(message.payload).filter(([key]) => !key.startsWith('_')),
    ),
    wire: {
      seq: message.payload._seq,
      messageId: message.payload._messageId,
      channel: message.payload._channel,
      channelScope,
    },
  });
  const parsed = JSON.parse(stringified) as OutgoingWireMessage<'channel'> & {
    wire: { channelScope: string | null };
  };
  if (parsed.wire.channelScope === undefined) {
    (parsed.wire as { channelScope: string | null }).channelScope = null;
  }
  return parsed;
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
      engine.sendReplay(String(baseCtx.id), wire.channel ?? null, null, event, payload, wire);
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
    __dependencies: [sequence, dedup],
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
              message.payload,
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
              message.payload,
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

      engine.onProtocolMessage('_replay', async (ctx, payload) => {
        const baseCtx = ctx as Record<PropertyKey, unknown>;
        const scope = readReplayContextScope(baseCtx);

        // Only handle the replay request if it matches this primitive's scope
        // (top-level vs. the correct channel).
        if (!matchesReplayScope(channelKey, scope, engine.getReplayClaimedChannelKeys())) {
          return false;
        }

        const connection = baseCtx[ENGINE_INTERNAL_CONNECTION] as RuntimeConnection | undefined;
        // Channel-scoped replay requests — including those landing on the
        // top-level custom-replay handler when the request carries
        // `_channel`/`_channelScope` — must verify membership. Otherwise any
        // connected client can harvest a channel's history by crafting one
        // replay frame.
        if (!isChannelReplayAuthorized(connection, scope, payload)) {
          return true;
        }

        if (channelKey && scope.channelName) {
          // Channel primitive scope: build the channel-shaped context.
          // Membership keys store the raw wire `_channelScope`; mirror that
          // here so the context's sendReplay routes through the right scope.
          const wireChannelScope: string | null =
            typeof payload?._channelScope === 'string' ? payload._channelScope : null;

          await opts.onReplay(
            createChannelReplayContext(
              engine,
              baseCtx,
              scope.channelName,
              wireChannelScope,
            ) as ReplayContext<CustomReplayScope>,
            Number(payload?.since ?? 0),
          );
          return true;
        }

        const requestChannel = typeof payload?._channel === 'string' ? payload._channel : null;
        const requestChannelScope =
          typeof payload?._channelScope === 'string' ? payload._channelScope : null;
        await opts.onReplay(
          createTopLevelReplayContext(engine, baseCtx, {
            channel: requestChannel,
            channelScope: requestChannelScope,
          }) as ReplayContext<CustomReplayScope>,
          Number(payload?.since ?? 0),
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
