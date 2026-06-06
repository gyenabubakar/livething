import { dispatchToHandlers } from '~/internal/dispatch.ts';
import type { WSKitError } from '@wskit/core';
import type { PrimitiveLogger } from '~/internal/runtime.ts';
import type { ChannelMember, SubscribeSource } from '~/primitives/channels/types.ts';

type Handler = (data: unknown) => void;
type MemberCallback = (connectionId: string, member: ChannelMember) => void;
type LeaveCallback = (connectionId: string) => void;

/**
 * A tiny set-of-callbacks helper: `add` returns an unsubscribe, `each` runs them
 * all in isolation — a throwing listener can't stop its siblings, and the throw
 * is reported on the (debug-gated) log channel. `getLog` is read lazily so it can
 * reference the owning instance's logger, which is set after the field runs.
 */
function listeners<F>(getLog: () => PrimitiveLogger) {
  const set = new Set<F>();
  return {
    add(callback: F): () => void {
      set.add(callback);
      return () => set.delete(callback);
    },
    each(run: (callback: F) => void): void {
      for (const callback of [...set]) {
        try {
          run(callback);
        } catch (error) {
          getLog().error('a channel listener threw', error);
        }
      }
    },
  };
}

/**
 * Everything the client tracks for one channel: who's in it, who's listening,
 * and the state of its subscription. One of these exists per concrete channel
 * (a fixed channel, or one name inside a dynamic family).
 */
export class ChannelState {
  /** True once the server has confirmed the subscription. */
  active = false;
  /**
   * True when the server marks this channel persistent (it auto-rejoins on
   * reconnect). The client then leaves rejoin to the server and does not
   * re-subscribe this channel itself. Set from `__subscribeOk__`.
   */
  persistent = false;
  /**
   * True while a reconnect is awaiting this channel's subscribe outcome — the
   * client's reconnect re-subscribe (non-persistent) or the server's auto-rejoin
   * (persistent). A channel-scoped `__error__` during this window is a rejected
   * (re)subscribe, so the channel is cleared; outside it the same frame is a
   * message error and the subscription is left intact.
   */
  rejoining = false;
  /**
   * What was passed to `subscribe()` — a value, or a function re-run on each
   * reconnect to refresh a rotating payload (e.g. an auth token).
   */
  subscribeData: unknown;
  /**
   * The concrete payload to (re)send: `subscribeData` itself for a value, or the
   * latest result of calling it for a function. Refreshed before each reconnect.
   */
  resolvedSubscribeData: unknown;
  /** The pending `subscribe()` promise, if a call is waiting for confirmation. */
  pending: { resolve: () => void; reject: (err: unknown) => void } | null = null;
  /** The in-flight `subscribe()` promise, reused so overlapping calls don't orphan the first. */
  pendingPromise: Promise<void> | null = null;
  /** Drops the lazy "keep awake" hold taken by `subscribe()`. Held until the subscription ends. */
  private lazyRelease: (() => void) | null = null;

  readonly members = new Map<string, ChannelMember>();
  readonly handlers = new Map<string, Set<Handler>>();

  private readonly subscribed = listeners<(source: SubscribeSource) => void>(() => this.log);
  private readonly unsubscribed = listeners<() => void>(() => this.log);
  private readonly kicked = listeners<(reason: string) => void>(() => this.log);
  private readonly subFailed = listeners<(error: WSKitError) => void>(() => this.log);
  private readonly memberJoin = listeners<MemberCallback>(() => this.log);
  private readonly memberLeave = listeners<LeaveCallback>(() => this.log);
  private readonly memberOnline = listeners<MemberCallback>(() => this.log);
  private readonly memberOffline = listeners<LeaveCallback>(() => this.log);

  constructor(
    /** The `__wskit.channel` value. */
    readonly name: string,
    /** The `__wskit.channelScope` value, for a channel inside a dynamic family. */
    readonly scopeKey: string | undefined,
    /** Debug-gated logger, used to report a throwing event handler. */
    private readonly log: PrimitiveLogger,
  ) {}

  // ── event listeners (each returns an unsubscribe) ──
  onSubscribed = this.subscribed.add;
  onUnsubscribed = this.unsubscribed.add;
  onKicked = this.kicked.add;
  onSubscriptionFailed = this.subFailed.add;
  onMemberJoin = this.memberJoin.add;
  onMemberLeave = this.memberLeave.add;
  onMemberOnline = this.memberOnline.add;
  onMemberOffline = this.memberOffline.add;

  /** Register an `on(event)` handler; returns an unsubscribe. */
  addHandler(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(event);
    };
  }

  /** Deliver an incoming event to this channel's handlers. */
  dispatch(event: string, payload: unknown): void {
    dispatchToHandlers(this.handlers.get(event), this.log, payload);
  }

  // ── transitions the routing layer drives ──

  /** Take a lazy "keep the socket awake" hold for this subscription's lifetime (at most one). */
  holdLazy(acquire: () => void, release: () => void): void {
    if (this.lazyRelease) return;
    acquire();
    this.lazyRelease = release;
  }

  /** Drop the lazy hold if one is held. Safe to call more than once. */
  releaseLazy(): void {
    const release = this.lazyRelease;
    this.lazyRelease = null;
    release?.();
  }

  /** Mark active and tell `onSubscribed` listeners who started it. */
  markSubscribed(source: SubscribeSource): void {
    this.active = true;
    this.rejoining = false;
    if (source === 'client' && this.pending) {
      this.pending.resolve();
      this.pending = null;
      this.pendingPromise = null;
    }
    this.subscribed.each((callback) => callback(source));
  }

  /** Mark inactive, clear members, and tell `onUnsubscribed` listeners. */
  markUnsubscribed(): void {
    this.active = false;
    this.rejoining = false;
    this.members.clear();
    // The subscription is over (unsubscribe or kick) — drop its lazy hold and any
    // in-flight subscribe(), so a later subscribe() starts a fresh attempt instead
    // of reusing this dead one.
    this.releaseLazy();
    this.pending = null;
    this.pendingPromise = null;
    this.unsubscribed.each((callback) => callback());
  }

  fireKicked(reason: string): void {
    this.kicked.each((callback) => callback(reason));
  }

  fireSubscriptionFailed(error: WSKitError): void {
    // The subscription failed (rejected subscribe, or a reconnect re-subscribe) —
    // it's no longer a consumer, so drop its lazy hold.
    this.releaseLazy();
    // Only clear the channel when a (re)subscribe was actually in flight: a live
    // subscribe() with a pending promise, or a reconnect rejoin (`rejoining`).
    // A channel-scoped `__error__` outside that window is a message error — keep
    // `active` so one bad send doesn't unsubscribe a healthy channel.
    if (this.pending !== null || this.rejoining) {
      this.active = false;
      this.persistent = false;
      this.rejoining = false;
      this.members.clear();
    }
    // A live subscribe() call rejects; a reconnect re-subscribe surfaces here instead.
    if (this.pending) {
      this.pending.reject(error);
      this.pending = null;
      this.pendingPromise = null;
    } else {
      this.subFailed.each((callback) => callback(error));
    }
  }

  /** Replace the whole member list (from `__memberSync__`) and replay join/online. */
  syncMembers(members: { connectionId: string; meta?: Record<string, unknown> }[]): void {
    this.members.clear();
    for (const { connectionId, meta } of members) {
      const member: ChannelMember = { meta: meta ?? {} };
      this.members.set(connectionId, member);
      this.memberJoin.each((callback) => callback(connectionId, member));
      this.memberOnline.each((callback) => callback(connectionId, member));
    }
  }

  addMember(connectionId: string, meta?: Record<string, unknown>): void {
    const member: ChannelMember = { meta: meta ?? {} };
    this.members.set(connectionId, member);
    this.memberJoin.each((callback) => callback(connectionId, member));
  }

  removeMember(connectionId: string): void {
    this.members.delete(connectionId);
    this.memberLeave.each((callback) => callback(connectionId));
  }

  memberWentOnline(connectionId: string, meta?: Record<string, unknown>): void {
    this.memberOnline.each((callback) => callback(connectionId, { meta: meta ?? {} }));
  }

  memberWentOffline(connectionId: string): void {
    this.memberOffline.each((callback) => callback(connectionId));
  }

  /** Clear members but keep the subscription (used on a network drop). */
  clearMembersForReconnect(): void {
    this.members.clear();
  }
}

/**
 * Family-level state for a dynamic channel family (`socket.channel.scope(key)`).
 * Its listeners fire for every concrete channel in the family, with the channel
 * name passed along so callers can tell which one.
 */
export class FamilyState {
  private readonly familyHandlers = new Map<
    string,
    Set<(data: unknown, channelName: string) => void>
  >();
  private readonly subscribed = listeners<(channelName: string, source: SubscribeSource) => void>(
    () => this.log,
  );
  private readonly unsubscribed = listeners<(channelName: string) => void>(() => this.log);

  /** @param log debug-gated logger, used to report a throwing event handler. */
  constructor(private readonly log: PrimitiveLogger) {}

  onSubscribed = this.subscribed.add;
  onUnsubscribed = this.unsubscribed.add;

  addHandler(event: string, handler: (data: unknown, channelName: string) => void): () => void {
    let set = this.familyHandlers.get(event);
    if (!set) {
      set = new Set();
      this.familyHandlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.familyHandlers.delete(event);
    };
  }

  dispatch(event: string, payload: unknown, channelName: string): void {
    dispatchToHandlers(this.familyHandlers.get(event), this.log, payload, channelName);
  }

  fireSubscribed(channelName: string, source: SubscribeSource): void {
    this.subscribed.each((callback) => callback(channelName, source));
  }

  fireUnsubscribed(channelName: string): void {
    this.unsubscribed.each((callback) => callback(channelName));
  }
}

/** Build the routing key for a channel — scope-qualified so families don't clash. */
export function channelKey(name: string, scopeKey?: string): string {
  return scopeKey ? `${scopeKey} ${name}` : name;
}
