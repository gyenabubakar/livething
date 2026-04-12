import { dedup } from '~/dedup/dedup.ts';
import { definePrimitive } from '~/primitive.ts';
import {
  matchesReplayScope,
  readReplayContextScope,
  shouldStoreReplayMessage,
} from '~/replay/runtime.ts';
import { sequence } from '~/sequence/sequence.ts';
import type { ReplayWire } from '~/_types/scope-state.ts';
import type { KVProvider, Logger, SQLProvider } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';

export type CustomReplayScope = 'top' | 'channel';

export interface TopLevelOutgoingWire {
  readonly seq: number;
  readonly messageId: string;
}

export interface ChannelOutgoingWire extends TopLevelOutgoingWire {
  readonly channel: string;
  readonly channelScope: string;
}

export type OutgoingWire<TScope extends CustomReplayScope> = TScope extends 'channel'
  ? ChannelOutgoingWire
  : TopLevelOutgoingWire;

/**
 * One finalized outgoing message snapshot passed to manual replay hooks.
 *
 * The app payload stays separate from wskit's protocol metadata so product
 * code can store both cleanly without mixing them together.
 */
export interface OutgoingWireMessage<TScope extends CustomReplayScope = 'top'> {
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly wire: OutgoingWire<TScope>;
}

interface BaseCustomReplayContext {
  readonly id: string;
  readonly sql: SQLProvider;
  readonly kv: KVProvider;
  readonly env: Record<string, unknown>;
  readonly log: Logger;
  readonly platform: unknown;
  waitUntil(promise: Promise<unknown>): void;
}

export interface TopLevelReplayContext extends BaseCustomReplayContext {
  sendReplay(event: string, payload: Record<string, unknown>, wire: ReplayWire): void;
}

export interface ChannelReplayContext extends BaseCustomReplayContext {
  readonly channel: {
    readonly name: string;
  };
  sendReplay(event: string, payload: Record<string, unknown>, wire: ReplayWire): void;
}

export type ReplayContext<TScope extends CustomReplayScope> = TScope extends 'channel'
  ? ChannelReplayContext
  : TopLevelReplayContext;

/**
 * Manual replay hooks.
 *
 * Use `handleReplay(...)` when you want to manage replay storage and replay
 * responses yourself instead of using the built-in automatic `replay(...)`
 * primitive.
 */
export interface CustomReplayOptions<TScope extends CustomReplayScope = 'top'> {
  /**
   * Observe one finalized outgoing message before wskit sends it.
   *
   * The message is cloned through JSON first, so your code can inspect it
   * freely without mutating the engine's live send payload.
   */
  readonly onBeforeSend?: (message: OutgoingWireMessage<TScope>) => void;

  /**
   * Observe one finalized outgoing message after wskit sends it.
   *
   * Use this for best-effort storage or analytics that should not block the
   * websocket send.
   */
  readonly onAfterSend?: (message: OutgoingWireMessage<TScope>) => void | Promise<void>;

  /**
   * Handle one client `_replay` request yourself.
   *
   * wskit gives you a replay-enabled context plus the client's last seen
   * sequence number. Your code decides what to load and what to resend.
   */
  readonly onReplay: (ctx: ReplayContext<TScope>, since: number) => void | Promise<void>;
}

export interface CustomReplayPrimitive<
  TScope extends CustomReplayScope = CustomReplayScope,
> extends Primitive<'customReplay'> {
  readonly options: CustomReplayOptions<TScope>;
}

const CUSTOM_REPLAY_KEY = Symbol('custom-replay');

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
      wire: {
        seq: message.payload._seq,
        messageId: message.payload._messageId,
      },
    }),
  ) as OutgoingWireMessage<'top'>;
}

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

function createTopLevelReplayContext(
  engine: {
    sendReplay(
      connectionId: string,
      channelName: string | undefined,
      channelScope: string | undefined,
      event: string,
      payload: unknown,
      wire: ReplayWire,
    ): void;
  },
  baseCtx: Record<PropertyKey, unknown>,
): TopLevelReplayContext {
  return {
    id: String(baseCtx.id),
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

function createChannelReplayContext(
  engine: {
    sendReplay(
      connectionId: string,
      channelName: string | undefined,
      channelScope: string | undefined,
      event: string,
      payload: unknown,
      wire: ReplayWire,
    ): void;
  },
  baseCtx: Record<PropertyKey, unknown>,
  channelName: string,
  channelScope: string,
): ChannelReplayContext {
  return {
    id: String(baseCtx.id),
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

const _customReplay = definePrimitive<
  'customReplay',
  [options: CustomReplayOptions<CustomReplayScope>],
  { options: CustomReplayOptions<CustomReplayScope> }
>({
  tag: 'customReplay' as const,
  key: CUSTOM_REPLAY_KEY,
  kind: 'infrastructure' as const,
  dependencies: [sequence, dedup],
  create(options: CustomReplayOptions<CustomReplayScope>) {
    return { options };
  },
  setup(engine, data) {
    const { channelKey } = engine.getScopeInfo();

    if (data.options.onBeforeSend) {
      engine.onBeforeSend((message) => {
        if (!shouldStoreReplayMessage(channelKey, message.event, message.payload, new Set())) {
          return;
        }

        if (channelKey) {
          data.options.onBeforeSend!(
            toChannelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>,
          );
          return;
        }

        data.options.onBeforeSend!(
          toTopLevelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>,
        );
      });
    }

    if (data.options.onAfterSend) {
      engine.onAfterSend((message) => {
        if (!shouldStoreReplayMessage(channelKey, message.event, message.payload, new Set())) {
          return;
        }

        if (channelKey) {
          return data.options.onAfterSend!(
            toChannelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>,
          );
        }

        return data.options.onAfterSend!(
          toTopLevelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>,
        );
      });
    }

    engine.onProtocolMessage('_replay', async (ctx, payload) => {
      const baseCtx = ctx as Record<PropertyKey, unknown>;
      const scope = readReplayContextScope(baseCtx);

      if (!matchesReplayScope(channelKey, scope)) return false;

      if (channelKey && scope.channelName && scope.channelScope) {
        await data.options.onReplay(
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

      await data.options.onReplay(
        createTopLevelReplayContext(engine, baseCtx) as ReplayContext<CustomReplayScope>,
        Number(payload?.since ?? 0),
      );
      return true;
    });
  },
});

/**
 * Handle replay requests yourself.
 *
 * The same primitive works at the top level and inside `channel(...)`.
 * Use the generic parameter when you want editor hovers to reflect the scope:
 *
 * ```ts
 * handleReplay<'channel'>({ ... })
 * ```
 */
export function handleReplay<TScope extends CustomReplayScope = 'top'>(
  options: CustomReplayOptions<TScope>,
): CustomReplayPrimitive<TScope> {
  return _customReplay(
    options as CustomReplayOptions<CustomReplayScope>,
  ) as CustomReplayPrimitive<TScope>;
}

handleReplay.__key = CUSTOM_REPLAY_KEY;

import '~/_builder/side-effects/replay-custom.ts';
