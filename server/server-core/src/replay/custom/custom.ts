/* oxlint-disable @typescript-eslint/no-explicit-any */
/* oxlint-disable eslint-plugin-import(no-cycle) */

import { dedup } from '~/dedup/dedup.ts';
import {
  matchesReplayScope,
  readReplayContextScope,
  shouldStoreReplayMessage,
} from '~/replay/runtime.ts';
import { sequence } from '~/sequence/sequence.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { ReplayWire } from '~/_types/scope-state.ts';
import type { KVProvider, Logger, SQLProvider } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * Discriminates the scope a `CustomReplayPrimitive` or its context operates in.
 * - `'top'` — top-level connection scope.
 * - `'channel'` — inside a channel scope.
 */
export type CustomReplayScope = 'top' | 'channel';

/**
 * Wire metadata present on every top-level outgoing message after sequence and
 * dedup stamping. Consumers use these values as storage keys and replay cursors.
 */
export interface TopLevelOutgoingWire {
  /** Monotonically increasing sequence number stamped by the `sequence` primitive. */
  readonly seq: number;
  /** Unique message ID stamped by the `dedup` primitive. */
  readonly messageId: string;
}

/**
 * Wire metadata for messages sent inside a channel scope. Extends the top-level
 * wire with the channel name and scope key.
 */
export interface ChannelOutgoingWire extends TopLevelOutgoingWire {
  /** The channel name the message was sent on. */
  readonly channel: string;
  /** The channel scope key (used for dynamic / parameterised channels). */
  readonly channelScope: string;
}

/**
 * Resolves to `ChannelOutgoingWire` for channel-scoped primitives and to
 * `TopLevelOutgoingWire` for top-level primitives.
 */
export type OutgoingWire<TScope extends CustomReplayScope> = TScope extends 'channel'
  ? ChannelOutgoingWire
  : TopLevelOutgoingWire;

/**
 * The message object passed to `onBeforeSend` and `onAfterSend`. Contains the
 * clean application payload (internal `_seq`, `_messageId`, and similar fields
 * are stripped) and the `wire` metadata object.
 */
export interface OutgoingWireMessage<TScope extends CustomReplayScope = 'top'> {
  /** The event name. */
  readonly event: string;
  /** The application payload with internal fields removed. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Wire metadata (sequence number, message ID, and for channels: channel info). */
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
 */
export interface TopLevelReplayContext extends BaseCustomReplayContext {
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
> extends Primitive<'customReplay'> {
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
  return JSON.parse(
    JSON.stringify({
      event: message.event,
      payload: Object.fromEntries(
        Object.entries(message.payload).filter(([key]) => !key.startsWith('_')),
      ),
      wire: { seq: message.payload._seq, messageId: message.payload._messageId },
    }),
  ) as OutgoingWireMessage<'top'>;
}

/**
 * Same as `toTopLevelWireMessage` but for channel-scoped messages. Adds
 * `channel` and `channelScope` to the `wire` object from the internal payload.
 */
function toChannelWireMessage(message: {
  event: string;
  payload: Record<string, unknown>;
}): OutgoingWireMessage<'channel'> {
  return JSON.parse(
    JSON.stringify({
      event: message.event,
      payload: Object.fromEntries(
        Object.entries(message.payload).filter(([key]) => !key.startsWith('_')),
      ),
      wire: {
        seq: message.payload._seq,
        messageId: message.payload._messageId,
        channel: message.payload._channel,
        channelScope: message.payload._channelScope,
      },
    }),
  ) as OutgoingWireMessage<'channel'>;
}

/**
 * Build the `TopLevelReplayContext` passed to the developer's `onReplay` hook
 * at the top-level connection scope.
 */
function createTopLevelReplayContext(
  engine: EngineAccess,
  baseCtx: Record<PropertyKey, unknown>,
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
    sendReplay(event, payload, wire) {
      engine.sendReplay(String(baseCtx.id), wire.channel, undefined, event, payload, wire);
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
  channelScope: string,
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
 * Creates a custom replay primitive. When registered, this primitive wires
 * three optional hooks into the engine's message pipeline, letting developers
 * store and replay messages using any storage backend of their choice.
 *
 * The primitive automatically depends on `sequence` and `dedup` — both will
 * be auto-injected if not already registered, so that every outgoing message
 * is stamped with `_seq` and `_messageId` before the hooks are called.
 *
 * In practice you rarely call `handleReplay()` directly. Use it through the
 * builder: `server('name').replayCustom()…done()` — that method calls this
 * factory internally.
 *
 * @param options The three lifecycle hooks for storing and replaying messages.
 *
 * @example
 * ```ts
 * import '@wskit/server/replay/custom';
 *
 * server('chat')
 *   .replayCustom()
 *   .onBeforeSend((ctx, msg) => {
 *     ctx.sql.exec('INSERT INTO replay ...', msg.event, msg.wire.seq);
 *   })
 *   .onReplay(async (ctx, since) => {
 *     const rows = ctx.sql.exec('SELECT ... WHERE seq > ?', since).toArray();
 *     for (const row of rows) ctx.sendReplay(row.event, row.payload, row.wire);
 *   })
 *   .build();
 * ```
 */
export function handleReplay<TScope extends CustomReplayScope = 'top'>(
  options: CustomReplayOptions<TScope>,
): CustomReplayPrimitive<TScope> {
  const opts = options as CustomReplayOptions<CustomReplayScope>;

  return {
    __wskit: 'customReplay',
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
          if (!shouldStoreReplayMessage(channelKey, message.event, message.payload, new Set()))
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
          if (!shouldStoreReplayMessage(channelKey, message.event, message.payload, new Set()))
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
        if (!matchesReplayScope(channelKey, scope)) return false;

        if (channelKey && scope.channelName && scope.channelScope) {
          await opts.onReplay(
            createChannelReplayContext(
              engine,
              baseCtx,
              scope.channelName,
              scope.channelScope,
            ) as ReplayContext<CustomReplayScope>,
            Number(payload?.since ?? 0),
          );
          return true;
        }

        await opts.onReplay(
          createTopLevelReplayContext(engine, baseCtx) as ReplayContext<CustomReplayScope>,
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
