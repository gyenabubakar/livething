/* oxlint-disable @typescript-eslint/no-explicit-any */
/* oxlint-disable eslint-plugin-import(no-cycle) */

import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import {
  isChannelReplayAuthorized,
  matchesReplayScope,
  readReplayContextScope,
  shouldStoreReplayMessage,
} from '~/replay/runtime.ts';
import { createSendReplayExtender, readConnectionId } from '~/replay/send-replay.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { RuntimeConnection, WireBroadcastMessage } from '~/_engine/runtime/types.ts';
import type { KVProvider, Logger, SQLProvider } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReplayWire } from '../wire.ts';

type CreateTopLevelReplayContextRequestParameter = {
  channel: string | null;
  channelFamily: string | null;
};

/**
 * Discriminates the scope a `CustomReplayPrimitive` or its context operates in.
 * - `'top'` — top-level connection scope.
 * - `'channel'` — inside a channel scope.
 */
export type CustomReplayScope = 'top' | 'channel';

/**
 * Metadata attached to every message a top-level custom replay stores. Your
 * `beforeBroadcast` / `afterBroadcast` hooks receive this as `message.wire`. Use
 * `deliverySeq` as a replay cursor and `messageId` as a storage key.
 *
 * Top-level custom replay also stores channel messages (the cascade behavior),
 * except for channels that register their own `channel.replay({ ... })`. When
 * a message was broadcast inside a channel, `channel` is the concrete channel
 * name; otherwise it is `null`. When the channel is a dynamic family,
 * `channelFamily` is the family key; otherwise it is `null`. Store both with
 * the row so your `replay` hook can filter by them later.
 */
export interface TopLevelOutgoingWire {
  /**
   * The message's delivery sequence number. One counter for the whole server,
   * so it only grows and never repeats across connections; one connection sees
   * gaps where other connections were sent other messages.
   */
  readonly deliverySeq: number;

  /** A unique ID for this message. */
  readonly messageId: string;

  /**
   * Concrete channel name when the message was broadcast inside a channel,
   * `null` for top-level messages. Use this together with `channelFamily` as
   * the storage key for channel rows.
   */
  readonly channel: string | null;

  /**
   * Family key (matching `scope(key, pattern)`) for dynamic channels,
   * `null` for static channels and for top-level messages. Read this with a
   * null-guard.
   */
  readonly channelFamily: string | null;
}

/**
 * Wire metadata for messages stored by a channel's `channel.replay({ ... })`.
 * It only sees messages from its own channel, so `channel` is always set.
 */
export interface ChannelOutgoingWire extends TopLevelOutgoingWire {
  /** The channel name the message was broadcast on. Always present. */
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
 * One broadcast your `beforeBroadcast` and `afterBroadcast` hooks receive. Contains the
 * event name, the application payload, the user it was addressed to, and a
 * `wire` object you can use as a storage key and replay cursor.
 */
export interface OutgoingWireMessage<TScope extends CustomReplayScope = 'top'> {
  /** The event name. */
  readonly event: string;

  /** The application payload. */
  readonly payload: Readonly<Record<string, unknown>>;

  /**
   * Who may replay this message.
   *
   * - `null` — it was broadcast to everyone in its scope (`ctx.broadcast`,
   *   `ctx.channel.broadcast`). Replay it to anyone who may read that scope.
   * - A user id — it was broadcast to that one user (`ctx.user.broadcast`,
   *   `ctx.users.get(id).broadcast`, `ctx.channel.broadcastTo(userRef, ...)`).
   *   Replay it only when `ctx.userId` in your `replay` hook is the same id.
   *
   * Store it with the row.
   */
  readonly userId: string | null;

  /** Metadata — sequence number, message ID, and for channels, channel info. */
  readonly wire: OutgoingWire<TScope>;
}

/**
 * The context passed to `beforeBroadcast` and `afterBroadcast`. Provides storage and
 * platform access so the hooks can store messages.
 */
export interface CustomReplaySendContext {
  /** SQL access for storing messages in your own replay store. */
  readonly sql: SQLProvider;

  /** KV access for storing messages in your own replay store. */
  readonly kv: KVProvider;

  /** Structured logger. */
  readonly log: Logger;

  /** Platform-specific context (e.g. the Cloudflare `DurableObjectState`). */
  readonly platform: unknown;
}

/** Shared context fields available in all `replay` hook contexts. */
interface BaseCustomReplayContext {
  /** The connection ID of the client that requested replay. */
  readonly id: string;

  /**
   * The user id of the client that requested replay, or `null` for an
   * anonymous connection. Only send it rows whose stored `userId` is `null`
   * or this same id.
   */
  readonly userId: string | null;

  /** The per-connection metadata from `onUpgrade`. */
  readonly meta: Record<string, unknown>;

  /** SQL access for querying your own replay store. */
  readonly sql: SQLProvider;

  /** KV access for querying your own replay store. */
  readonly kv: KVProvider;

  /** Structured logger. */
  readonly log: Logger;

  /** Platform-specific context (e.g. the Cloudflare `DurableObjectState`). */
  readonly platform: unknown;
}

/**
 * The context passed to the top-level `replay` hook. Provides `sendReplay()`
 * for re-sending stored messages to the reconnecting client.
 *
 * `request.channel` is the concrete channel name when the client's `__replay__`
 * frame was scoped to a channel, otherwise `null`. `request.channelFamily` is
 * the family key for dynamic channels, `null` for static channels and for
 * unscoped replay requests. Read both with null-guards. Use them to filter
 * stored rows when serving replay back.
 */
export interface TopLevelReplayContext extends BaseCustomReplayContext {
  /** Routing markers from the client's `__replay__` frame. */
  readonly request: {
    /** Channel name from `__livething.channel` on the request, or `null`. */
    readonly channel: string | null;
    /** Family key from `__livething.channelFamily` on the request, or `null`. */
    readonly channelFamily: string | null;
  };
  /**
   * Send one previously stored message to the reconnecting client.
   *
   * @param event   The original event name.
   * @param payload The original application payload.
   * @param wire    The original wire metadata (deliverySeq, messageId, channel).
   */
  sendReplay(event: string, payload: Record<string, unknown>, wire: ReplayWire): void;
}

/**
 * The context passed to a channel's `replay` hook. Extends the shared context
 * with `channel.name`.
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
 * Hooks that describe a custom replay strategy: how broadcasts get stored (via
 * `onBeforeBroadcast` or `onAfterBroadcast`) and how they get replayed back to a
 * reconnecting client (via `onReplay`). Implement this instead of the built-in
 * `replay()` when you need custom storage — e.g. a third-party database, a
 * message broker, or cross-region replication.
 *
 * The store hooks follow the same rule as built-in replay. Each one runs once
 * per broadcast, even when no connection receives it live:
 *
 * - `ctx.broadcast` / `ctx.channel.broadcast` arrive with `message.userId`
 *   set to `null`.
 * - `ctx.user.broadcast`, `ctx.users.get(id).broadcast` and
 *   `ctx.channel.broadcastTo(userRef, ...)` arrive with `message.userId` set to
 *   that user.
 * - `ctx.send`, `ctx.connections.get(ref).send`, `ctx.channel.send`,
 *   `ctx.channel.broadcastTo` a connection, tag or group, and tag broadcasts
 *   never arrive. A reconnect opens a new connection with a new id, so no later
 *   connection could prove it was the one addressed.
 *
 * Only `onReplay` is required.
 *
 * Beginner mental model:
 * - `onBeforeBroadcast` or `onAfterBroadcast` writes messages into your store
 * - `onReplay` reads those messages later and calls `ctx.sendReplay(...)`
 */
export interface CustomReplayOptions<TScope extends CustomReplayScope = 'top'> {
  /**
   * Called once per broadcast, before any recipient is sent the frame. Store
   * the message here for strict durability: if this hook throws, no recipient
   * receives the broadcast.
   *
   * @param ctx     Storage and platform access (sql, kv, log, platform).
   * @param message The broadcast with its payload, `userId` and wire metadata.
   */
  readonly onBeforeBroadcast?: (
    ctx: CustomReplaySendContext,
    message: OutgoingWireMessage<TScope>,
  ) => void;

  /**
   * Called once per broadcast (optionally async), after every recipient was
   * sent the frame. Store the message here for best-effort durability: a throw
   * or rejection is logged and never affects delivery.
   *
   * @param ctx     Storage and platform access (sql, kv, log, platform).
   * @param message The broadcast with its payload, `userId` and wire metadata.
   */
  readonly onAfterBroadcast?: (
    ctx: CustomReplaySendContext,
    message: OutgoingWireMessage<TScope>,
  ) => void | Promise<void>;

  /**
   * Called when a client sends the `__replay__` protocol message. Query your own
   * store for the messages newer than `since` that `ctx.userId` may see, and
   * call `ctx.sendReplay()` for each.
   *
   * @param ctx   The replay context with `sendReplay()`, `userId` and storage access.
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
const CUSTOM_REPLAY_SEND_KEY = Symbol('custom-replay-send');
const NO_CLAIMED_CHANNELS: ReadonlySet<string> = new Set();

/**
 * Shape one broadcast into the `OutgoingWireMessage` the developer's
 * `onBeforeBroadcast` / `onAfterBroadcast` hooks receive. The wire metadata comes from
 * the frame's `__livething`; the payload is already pure user data.
 */
function toWireMessage(message: WireBroadcastMessage): OutgoingWireMessage<CustomReplayScope> {
  const { livething } = message;
  return {
    event: message.event,
    payload: message.payload,
    userId: message.userId || null,
    wire: {
      deliverySeq: Number(livething.deliverySeq),
      messageId: String(livething.messageId),
      channel: typeof livething.channel === 'string' ? livething.channel : null,
      channelFamily: typeof livething.channelFamily === 'string' ? livething.channelFamily : null,
    },
  };
}

interface ReplayRequester {
  connectionId: string;
  userId: string | null;
}

function readRequester(baseCtx: Record<PropertyKey, unknown>): ReplayRequester {
  const connection = baseCtx[ENGINE_INTERNAL_CONNECTION] as RuntimeConnection | undefined;
  return { connectionId: readConnectionId(baseCtx), userId: connection?.userId || null };
}

/**
 * Build the `TopLevelReplayContext` passed to the developer's `onReplay` hook
 * at the top-level connection scope.
 */
function createTopLevelReplayContext(
  engine: EngineAccess,
  baseCtx: Record<PropertyKey, unknown>,
  request: CreateTopLevelReplayContextRequestParameter,
): TopLevelReplayContext {
  const { connectionId, userId } = readRequester(baseCtx);
  return {
    id: connectionId,
    userId,
    meta: (baseCtx.meta as Record<string, unknown>) ?? {},
    sql: baseCtx.sql as SQLProvider,
    kv: baseCtx.kv as KVProvider,
    log: baseCtx.log as Logger,
    platform: baseCtx.platform,
    request,
    sendReplay(event, payload, wire) {
      engine.assertReplaySendContract(event, payload, {
        channel: wire.channel,
        channelFamily: wire.channelFamily,
      });
      engine.sendReplay(connectionId, {
        channelName: wire.channel ?? null,
        channelFamily: wire.channelFamily ?? null,
        event,
        payload,
        wire,
      });
    },
  };
}

export interface CreateChannelReplayContextOptions {
  channelName: string;
  channelFamily: string | null;
}

/**
 * Build the `ChannelReplayContext` passed to the developer's `onReplay` hook
 * when the `__replay__` request targets a specific channel.
 */
function createChannelReplayContext(
  engine: EngineAccess,
  baseCtx: Record<PropertyKey, unknown>,
  options: CreateChannelReplayContextOptions,
): ChannelReplayContext {
  const { channelName, channelFamily } = options;
  const { connectionId, userId } = readRequester(baseCtx);
  return {
    id: connectionId,
    userId,
    meta: (baseCtx.meta as Record<string, unknown>) ?? {},
    channel: { name: channelName },
    sql: baseCtx.sql as SQLProvider,
    kv: baseCtx.kv as KVProvider,
    log: baseCtx.log as Logger,
    platform: baseCtx.platform,
    sendReplay(event, payload, wire) {
      engine.assertReplaySendContract(event, payload, {
        channel: channelName,
        channelFamily,
      });
      engine.sendReplay(connectionId, {
        channelName,
        channelFamily,
        event,
        payload,
        wire,
      });
    },
  };
}

/**
 * @internal
 *
 * The primitive `replay.custom()` always installs: it attaches `ctx.sendReplay`
 * and `ctx.channel.sendReplay` to every handler ctx, so handlers can resend a
 * stored message whether or not `base.replay(...)` is registered.
 */
export function customReplaySend(): Primitive<'replayCustomSend'> {
  return {
    __livething: 'replayCustomSend',
    __kind: 'infrastructure',
    __identity: [CUSTOM_REPLAY_SEND_KEY],
    __requires: {},
    __setup(engine: EngineAccess) {
      engine.extendContext(
        createSendReplayExtender(engine, {
          channelKey: undefined,
          claimedChannelKeys: () => NO_CLAIMED_CHANNELS,
        }),
      );
    },
  };
}

/**
 * @internal
 *
 * Internal primitive factory that powers `.replayCustom()`. It wires the
 * configured hooks into the engine's broadcast hooks and `__replay__` protocol
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
    __livething: 'replayCustom',
    __kind: 'infrastructure',
    __identity: [CUSTOM_REPLAY_KEY],
    __requires: {},
    options,
    __setup(engine: EngineAccess) {
      const { channelKey } = engine.getScopeInfo();
      const noExclude: ReadonlySet<string> = new Set();

      let sendCtx: CustomReplaySendContext | null = null;

      if (opts.onBeforeBroadcast || opts.onAfterBroadcast) {
        engine.onInit((ctx) => {
          const base = ctx as Record<PropertyKey, unknown>;
          sendCtx = {
            sql: base.sql as SQLProvider,
            kv: base.kv as KVProvider,
            log: base.log as Logger,
            platform: base.platform,
          };
        });
      }

      function owns(message: WireBroadcastMessage): boolean {
        return shouldStoreReplayMessage(message.event, {
          channelKey,
          livething: message.livething,
          exclude: noExclude,
          claimedChannelKeys: engine.getReplayClaimedChannelKeys(),
        });
      }

      const { onBeforeBroadcast, onAfterBroadcast } = opts;

      if (onBeforeBroadcast) {
        engine.onBeforeBroadcast((message) => {
          if (!owns(message)) return;

          onBeforeBroadcast(sendCtx!, toWireMessage(message));
        });
      }

      if (onAfterBroadcast) {
        engine.onAfterBroadcast((message) => {
          if (!owns(message)) return;

          return onAfterBroadcast(sendCtx!, toWireMessage(message));
        });
      }

      engine.onProtocolMessage('__replay__', async (ctx, frame) => {
        if (frame.event !== '__replay__') return false;

        const baseCtx = ctx as Record<PropertyKey, unknown>;
        const scope = readReplayContextScope(baseCtx);

        if (!matchesReplayScope(channelKey, scope, engine.getReplayClaimedChannelKeys())) {
          return false;
        }

        const connection = baseCtx[ENGINE_INTERNAL_CONNECTION] as RuntimeConnection | undefined;
        // Channel replay needs a membership check, or anyone could read its history.
        if (!isChannelReplayAuthorized(connection, scope, frame.__livething)) {
          return true;
        }

        const since = frame.payload.lastKnownSeq ?? 0;

        if (channelKey && scope.channelName) {
          await opts.onReplay(
            createChannelReplayContext(engine, baseCtx, {
              channelName: scope.channelName,
              channelFamily: frame.__livething.channelFamily ?? null,
            }) as ReplayContext<CustomReplayScope>,
            since,
          );
          return true;
        }

        await opts.onReplay(
          createTopLevelReplayContext(engine, baseCtx, {
            channel: frame.__livething.channel ?? null,
            channelFamily: frame.__livething.channelFamily ?? null,
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
