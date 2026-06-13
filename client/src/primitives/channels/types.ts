/* oxlint-disable @typescript-eslint/no-explicit-any -- contract matching needs `any` to stay generic */
import type { WSKitError } from '@wskit/core';
import type { Primitive, TypeFn } from '~/primitives/types.ts';
import type { IncomingOf, ScopedMessaging } from '~/types.ts';

/** One member of a channel. `meta` is the connection's metadata set on the server. */
export interface ChannelMember {
  meta: Record<string, unknown>;
}

/** Who started a subscription: the client asked, or the server pushed it. */
export type SubscribeSource = 'server' | 'client';

/**
 * A channel handle: an messaging (on/send/request/sendWithAck) plus the
 * server-managed-room controls — subscribing, membership, and presence.
 */
export type ChannelMessaging<C> = ScopedMessaging<C> & {
  /**
   * Join the channel. Resolves once the server confirms; rejects on auth failure
   * or disconnect. When the channel declares a `subscribePayload` (the server set
   * a `check` validator) the payload is required and typed; otherwise it's an
   * optional, untyped value.
   *
   * Pass a function instead of a value to regenerate the payload on every
   * reconnect — the way to keep a rotating credential (e.g. a per-channel auth
   * token) fresh, since the client re-subscribes automatically after a drop.
   */
  subscribe(
    ...args: C extends { subscribePayload: infer P }
      ? [data: P | (() => P | Promise<P>)]
      : [data?: unknown]
  ): Promise<void>;
  /**
   * Leave the channel. The channel goes inactive right away (a `send()` then
   * throws), but the returned promise resolves only when the server confirms the
   * leave with `__unsubscribeOk__` — the leave is resent across reconnects until
   * then. Rejects if the connection is abandoned before it can confirm.
   */
  unsubscribe(): Promise<void>;

  /** Who's in the room right now, keyed by connection id. */
  readonly members: ReadonlyMap<string, ChannelMember>;

  /** Someone joined the group. */
  onMemberJoin(callback: (connectionId: string, member: ChannelMember) => void): () => void;
  /** Someone left the group for good. */
  onMemberLeave(callback: (connectionId: string) => void): () => void;
  /** A connection became reachable (fires on reconnect too). */
  onMemberOnline(callback: (connectionId: string, member: ChannelMember) => void): () => void;
  /** A connection became unreachable (disconnect or true leave). */
  onMemberOffline(callback: (connectionId: string) => void): () => void;

  /** This channel became active — `source` says who initiated it. */
  onSubscribed(callback: (source: SubscribeSource) => void): () => void;
  /** This channel left the active set on the client side. */
  onUnsubscribed(callback: () => void): () => void;
  /** The server kicked you out, with a reason. */
  onKicked(callback: (reason: string) => void): () => void;
  /** A re-subscribe after reconnect was rejected (e.g. permissions changed). */
  onSubscriptionFailed(callback: (error: WSKitError) => void): () => void;
};

/**
 * A handle for a whole dynamic channel family. Call it like a function to get
 * one channel, or use the family-level listeners to watch every channel in it.
 */
export interface ScopeHandle<C> {
  /** Get the channel handle for one concrete name in this family. */
  (name: string): ChannelMessaging<C>;
  /** Listen across every channel in the family; the second arg is which one. */
  on<E extends keyof IncomingOf<C> & string>(
    event: E,
    handler: (data: IncomingOf<C>[E], channelName: string) => void,
  ): () => void;
  /** Any channel in the family became active. */
  onSubscribed(callback: (channelName: string, source: SubscribeSource) => void): () => void;
  /** Any channel in the family left the active set. */
  onUnsubscribed(callback: (channelName: string) => void): () => void;
  /** The concrete names currently active in this family. */
  list(): string[];
}

// A dynamic family has `addressing: 'dynamic'` in its contract entry, set by a
// `scope('key', 'tmpl-{id}')` declaration. A static channel has `addressing: 'static'`
// or no addressing field at all. All channels in a family share one event contract,
// so the family entry holds that shared contract plus the addressing marker.
type IsFamily<T> = T extends { addressing: 'dynamic' } ? true : false;

/** Keys of the channels map that are single, fixed channels. */
type FixedKeys<C> = { [K in keyof C]: IsFamily<C[K]> extends true ? never : K }[keyof C];

/** Keys of the channels map that are dynamic families. */
type FamilyKeys<C> = { [K in keyof C]: IsFamily<C[K]> extends true ? K : never }[keyof C];

/**
 * The `channel` method: `channel(name)` for a fixed channel, `channel(scope,
 * name)` for one inside a dynamic family, and `channel.scope(scope)` for a
 * whole family.
 */
export interface ChannelMethod<C> {
  <K extends FixedKeys<C> & string>(name: K): ChannelMessaging<C[K]>;
  <K extends FamilyKeys<C> & string>(scopeKey: K, name: string): ChannelMessaging<C[K]>;
  scope<K extends FamilyKeys<C> & string>(scopeKey: K): ScopeHandle<C[K]>;
}

/** Adds `socket.channel(...)` typed from the contract's `channels`. */
export interface ChannelsTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends { channels: infer C extends Record<string, any> }
    ? { channel: ChannelMethod<C> }
    : {};
}

/** Options for `channels()`. */
export interface ChannelsOptions {
  /** Buffer TTL for channel events: one number for all, or a per-event map. */
  ttl?: number | Record<string, number>;
}

/** The descriptor `channels()` returns. */
export type ChannelsPrimitive = Primitive<ChannelsTypeFn, { channels: Record<string, unknown> }>;
