/* oxlint-disable @typescript-eslint/no-explicit-any */
/* oxlint-disable eslint-plugin-import(no-cycle) */
import '~/_builder/side-effects/replay-custom.ts';
import { dedup } from '~/dedup/dedup.ts';
import type { EngineAccess } from '~/_engine/access.ts';
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
  readonly channel: { readonly name: string };
  sendReplay(event: string, payload: Record<string, unknown>, wire: ReplayWire): void;
}

export type ReplayContext<TScope extends CustomReplayScope> = TScope extends 'channel'
  ? ChannelReplayContext
  : TopLevelReplayContext;

export interface CustomReplayOptions<TScope extends CustomReplayScope = 'top'> {
  readonly onBeforeSend?: (message: OutgoingWireMessage<TScope>) => void;
  readonly onAfterSend?: (message: OutgoingWireMessage<TScope>) => void | Promise<void>;
  readonly onReplay: (ctx: ReplayContext<TScope>, since: number) => void | Promise<void>;
}

export interface CustomReplayPrimitive<
  TScope extends CustomReplayScope = CustomReplayScope,
> extends Primitive<'customReplay'> {
  readonly options: CustomReplayOptions<TScope>;
}

const CUSTOM_REPLAY_KEY = Symbol('custom-replay');

function toTopLevelWireMessage(message: { event: string; payload: Record<string, unknown> }): OutgoingWireMessage<'top'> {
  return JSON.parse(JSON.stringify({
    event: message.event,
    payload: Object.fromEntries(Object.entries(message.payload).filter(([key]) => !key.startsWith('_'))),
    wire: { seq: message.payload._seq, messageId: message.payload._messageId },
  })) as OutgoingWireMessage<'top'>;
}

function toChannelWireMessage(message: { event: string; payload: Record<string, unknown> }): OutgoingWireMessage<'channel'> {
  return JSON.parse(JSON.stringify({
    event: message.event,
    payload: Object.fromEntries(Object.entries(message.payload).filter(([key]) => !key.startsWith('_'))),
    wire: { seq: message.payload._seq, messageId: message.payload._messageId, channel: message.payload._channel, channelScope: message.payload._channelScope },
  })) as OutgoingWireMessage<'channel'>;
}

function createTopLevelReplayContext(
  engine: EngineAccess,
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
  engine: EngineAccess,
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

      if (opts.onBeforeSend) {
        engine.onBeforeSend((message) => {
          if (!shouldStoreReplayMessage(channelKey, message.event, message.payload, new Set())) return;
          opts.onBeforeSend!(channelKey
            ? toChannelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>
            : toTopLevelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>);
        });
      }

      if (opts.onAfterSend) {
        engine.onAfterSend((message) => {
          if (!shouldStoreReplayMessage(channelKey, message.event, message.payload, new Set())) return;
          return opts.onAfterSend!(channelKey
            ? toChannelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>
            : toTopLevelWireMessage(message) as OutgoingWireMessage<CustomReplayScope>);
        });
      }

      engine.onProtocolMessage('_replay', async (ctx, payload) => {
        const baseCtx = ctx as Record<PropertyKey, unknown>;
        const scope = readReplayContextScope(baseCtx);
        if (!matchesReplayScope(channelKey, scope)) return false;

        if (channelKey && scope.channelName && scope.channelScope) {
          await opts.onReplay(
            createChannelReplayContext(engine, baseCtx, scope.channelName, scope.channelScope) as ReplayContext<CustomReplayScope>,
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

handleReplay.__key = CUSTOM_REPLAY_KEY;
