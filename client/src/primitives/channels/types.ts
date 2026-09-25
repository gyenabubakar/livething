/* oxlint-disable @typescript-eslint/no-explicit-any -- contract matching needs `any` to stay generic */
import type { LiveThingError } from '@livething/core';
import type { ReadableStore } from '~/internal/store.ts';
import type { ApplyChannelPrimitives, Primitive, TypeFn } from '~/primitives/types.ts';
import type { IncomingOf, ScopedMessaging } from '~/types.ts';

/**
 * One member of a channel. `meta` is the connection's metadata set on the
 * server. When one user has several tabs in a persistent channel, it is the
 * meta of one of those tabs. For a member that is offline, it is the meta the
 * member had when it last joined.
 */
export interface ChannelMember {
  meta: Record<string, unknown>;
  /**
   * `true` while the member has a live connection in the channel. On a
   * persistent channel a member stays in the roster while it is offline, with
   * `online: false`, until it truly leaves.
   */
  online: boolean;
}

/** Who started a subscription: the client asked, or the server pushed it. */
export type SubscribeSource = 'server' | 'client';

/**
 * A channel's subscription state:
 * - `'subscribing'` — a `subscribe()` (or a reconnect rejoin) is in flight.
 * - `'subscribed'` — the server confirmed; sends and requests work.
 * - `'unsubscribed'` — not in the channel (never joined, left, or kicked).
 * - `'failed'` — a subscribe or a reconnect rejoin was rejected.
 */
export type ChannelStatus = 'subscribing' | 'subscribed' | 'unsubscribed' | 'failed';

/**
 * A channel handle: an messaging (on/send/request) plus the
 * server-managed-room controls — subscribing, membership, and presence.
 */
export type ChannelMessaging<C> = ScopedMessaging<C> & {
  /**
   * Join the channel. Resolves once the server confirms; rejects on auth failure
   * or disconnect. When the server declares the channel with a `subscribe`
   * schema, the payload is required and typed by it; otherwise it's an
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

  /**
   * Ask the server to resend this channel's member roster. Fire-and-forget —
   * it sends a `__memberSync__` request and returns immediately, with nothing to
   * await. Use it to recover a stale roster, e.g. after a leave that failed.
   */
  resyncMembers(): void;

  /**
   * Who's in the room, as a reactive store keyed by member id. On a persistent
   * channel the member id is the user's id, so one user is one entry across
   * reconnects and tabs. On an ephemeral channel, or for an anonymous
   * connection, it is the connection id.
   * `members.get()` reads the roster now; `members.subscribe(listener)` runs
   * with a fresh snapshot on every join, leave, roster sync, and change to a
   * member's `online` flag. A member stays in the roster until it truly leaves
   * (unsubscribe or removal, or a disconnect on an ephemeral channel or for an
   * anonymous connection); going offline only sets `online: false`.
   */
  readonly members: ReadableStore<ReadonlyMap<string, ChannelMember>>;

  /**
   * The subscription state as a reactive store — `status.get()` reads it now,
   * `status.subscribe(listener)` watches it. Handy for a "joining…" indicator
   * without wiring up the four lifecycle events below.
   */
  readonly status: ReadableStore<ChannelStatus>;

  /** Someone joined the group. `memberId` is the key used in `members`. */
  onMemberJoin(callback: (memberId: string, member: ChannelMember) => void): () => void;
  /** Someone left the group for good. */
  onMemberLeave(callback: (memberId: string) => void): () => void;
  /**
   * A member became reachable: its first live connection (fires on reconnect
   * too). Sets its `online` flag in `members`; never adds a roster entry.
   */
  onMemberOnline(callback: (memberId: string, member: ChannelMember) => void): () => void;
  /**
   * A member became unreachable: its last live connection dropped or left.
   * Clears its `online` flag in `members`; never removes a roster entry.
   */
  onMemberOffline(callback: (memberId: string) => void): () => void;

  /** This channel became active — `source` says who initiated it. */
  onSubscribed(callback: (source: SubscribeSource) => void): () => void;
  /** This channel left the active set on the client side. */
  onUnsubscribed(callback: () => void): () => void;
  /** The server kicked you out, with a reason. */
  onKicked(callback: (reason: string) => void): () => void;
  /** A re-subscribe after reconnect was rejected (e.g. permissions changed). */
  onSubscriptionFailed(callback: (error: LiveThingError) => void): () => void;
};

/**
 * A handle for a whole dynamic channel family. Call it like a function to get
 * one channel, or use the family-level listeners to watch every channel in it.
 */
export interface FamilyHandle<C> {
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
// `channel(['key', 'tmpl-{id}'])` declaration. A static channel has `addressing: 'static'`
// or no addressing field at all. All channels in a family share one event contract,
// so the family entry holds that shared contract plus the addressing marker.
type IsFamily<T> = T extends { addressing: 'dynamic' } ? true : false;

/** Keys of the channels map that are single, fixed channels. */
type FixedKeys<C> = { [K in keyof C]: IsFamily<C[K]> extends true ? never : K }[keyof C];

/** Keys of the channels map that are dynamic families. */
type FamilyKeys<C> = { [K in keyof C]: IsFamily<C[K]> extends true ? K : never }[keyof C];

/**
 * The `channel` method: `channel(name)` for a fixed channel, `channel(family,
 * name)` for one inside a dynamic family, and `channel.family(family)` for a
 * whole family.
 */
export interface ChannelMethod<C> {
  <K extends FixedKeys<C> & string>(name: K): ChannelMessaging<C[K]>;
  <K extends FamilyKeys<C> & string>(familyKey: K, name: string): ChannelMessaging<C[K]>;
  family<K extends FamilyKeys<C> & string>(familyKey: K): FamilyHandle<C[K]>;
}

/**
 * Like `ChannelMethod`, but every handle it hands back carries `Stubs` — the
 * `NeedsPrimitive` markers for channel-scoped methods whose primitive wasn't
 * installed — ON TOP OF the channel-handle surface each INSTALLED
 * channel-scoped primitive contributes (e.g. `inbox()`'s `receivers`). Used by
 * the client's missing-primitive guard to push those markers one level down
 * into the channel, so `channel('x').request(...)` stops compiling exactly
 * like the top-level `socket.request(...)` does, without erasing what an
 * installed primitive like `inbox()` already added to the handle.
 */
export interface StubbedChannelMethod<
  C,
  Stubs,
  TPrimitives extends readonly Primitive<any, any, any>[],
> {
  <K extends FixedKeys<C> & string>(name: K): StubbedMessaging<C[K], Stubs, TPrimitives>;
  <K extends FamilyKeys<C> & string>(
    familyKey: K,
    name: string,
  ): StubbedMessaging<C[K], Stubs, TPrimitives>;
  family<K extends FamilyKeys<C> & string>(
    familyKey: K,
  ): StubbedFamilyHandle<C[K], Stubs, TPrimitives>;
}

/**
 * One channel handle with the missing-primitive `Stubs` applied on top of the
 * surface every installed channel-scoped primitive contributes. The contract
 * always types `request`/`onStream`/etc. on the handle, so the stub must REPLACE
 * (`Omit` then add), not intersect — an intersected callable would still be
 * callable and the guard would do nothing. Installed primitives' members
 * (e.g. `receivers` from `inbox()`) are intersected in first, so a missing
 * `clientRequests()` doesn't also erase methods `inbox()` already installed.
 */
export type StubbedMessaging<
  C,
  Stubs,
  TPrimitives extends readonly Primitive<any, any, any>[],
> = Omit<ChannelMessaging<C> & ApplyChannelPrimitives<TPrimitives, C>, keyof Stubs> & Stubs;

/** A `FamilyHandle` whose member handles carry the channel-scoped stubs. */
export interface StubbedFamilyHandle<
  C,
  Stubs,
  TPrimitives extends readonly Primitive<any, any, any>[],
> {
  /** Get the channel handle for one concrete name in this family. */
  (name: string): StubbedMessaging<C, Stubs, TPrimitives>;
  on<E extends keyof IncomingOf<C> & string>(
    event: E,
    handler: (data: IncomingOf<C>[E], channelName: string) => void,
  ): () => void;
  onSubscribed(callback: (channelName: string, source: SubscribeSource) => void): () => void;
  onUnsubscribed(callback: (channelName: string) => void): () => void;
  list(): string[];
}

/**
 * Like `ChannelMethod`, but every handle it hands back also carries the
 * channel-handle surface each installed primitive contributes (via each
 * primitive's `_channelTypeFn`). Used by the client to graft `inbox()`'s and
 * `readReceipts()`'s per-channel methods onto handles only when those primitives
 * are registered, so `channel('room').receivers` compiles only then.
 */
export interface AugmentedChannelMethod<
  C,
  TPrimitives extends readonly Primitive<any, any, any>[],
> {
  <K extends FixedKeys<C> & string>(name: K): AugmentedMessaging<C[K], TPrimitives>;
  <K extends FamilyKeys<C> & string>(
    familyKey: K,
    name: string,
  ): AugmentedMessaging<C[K], TPrimitives>;
  family<K extends FamilyKeys<C> & string>(familyKey: K): AugmentedFamilyHandle<C[K], TPrimitives>;
}

/** One channel handle plus every installed primitive's channel-handle surface. */
export type AugmentedMessaging<
  C,
  TPrimitives extends readonly Primitive<any, any, any>[],
> = ChannelMessaging<C> & ApplyChannelPrimitives<TPrimitives, C>;

/** A `FamilyHandle` whose member handles carry the channel-primitive surface. */
export interface AugmentedFamilyHandle<C, TPrimitives extends readonly Primitive<any, any, any>[]> {
  /** Get the channel handle for one concrete name in this family. */
  (name: string): AugmentedMessaging<C, TPrimitives>;
  on<E extends keyof IncomingOf<C> & string>(
    event: E,
    handler: (data: IncomingOf<C>[E], channelName: string) => void,
  ): () => void;
  onSubscribed(callback: (channelName: string, source: SubscribeSource) => void): () => void;
  onUnsubscribed(callback: (channelName: string) => void): () => void;
  list(): string[];
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
