import { dispatchToHandlers } from '~/internal/dispatch.ts';
import type { WSKitError } from '@wskit/core';
import type { PrimitiveLogger, WireMessage } from '~/internal/runtime.ts';
import type { ChannelMember, SubscribeSource } from '~/primitives/channels/types.ts';

type Handler = (data: unknown) => void;
type MemberCallback = (connectionId: string, member: ChannelMember) => void;
type LeaveCallback = (connectionId: string) => void;

/**
 * Manages a set of callbacks. `add` registers one and returns an unsubscribe
 * function. `each` calls all of them: if one throws, the error is logged and the
 * rest still run. `getLog` is a function so it can reference the owning class's
 * logger, which is set after this field is initialized.
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
          getLog().report(error);
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
   * True while waiting for a subscribe confirmation after reconnect — either the
   * server's auto-rejoin (persistent channel) or the client's re-subscribe reply
   * (non-persistent). A channel `__error__` during this time means the rejoin
   * failed and the channel is cleared; the same error outside this window is just
   * a message error and the subscription stays active.
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
  /** A subscribe frame waiting for a connecting socket to open. */
  pendingSubscribeFrame: WireMessage | null = null;
  /**
   * An `__unsubscribe__` frame that couldn't be sent because the socket was
   * connecting/reconnecting. Held here and flushed on open. While set, the local
   * subscription is kept (so the server still sees us as a member) and any
   * automatic rejoin is suppressed — the user asked to leave, and that wins.
   */
  pendingUnsubscribeFrame: WireMessage | null = null;
  /**
   * Set when an intentional leave is flushed on reopen. The server may have
   * already queued an auto-rejoin `__subscribeOk__` (`source: 'server'`) before it
   * saw our `__unsubscribe__`; that stale confirmation must not re-activate a
   * channel the user just left. Cleared by a deliberate `subscribe()`.
   */
  ignoreServerRejoin = false;
  /** Releases the idle-prevention hold taken by `subscribe()`. Held until the subscription ends. */
  private lazyRelease: (() => void) | null = null;
  /** Handle for the persistent-rejoin fallback re-subscribe timer, so it can be cancelled. */
  rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  /** Roster captured at a network drop, so the next `__memberSync__` can fire only real deltas. */
  private priorMembers: Set<string> | null = null;

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

  /** Prevent the socket from going idle for this subscription's lifetime. Only takes effect once. */
  holdLazy(acquire: () => void, release: () => void): void {
    if (this.lazyRelease) return;
    acquire();
    this.lazyRelease = release;
  }

  /** Release the idle-prevention hold if one is active. Safe to call more than once. */
  releaseLazy(): void {
    const release = this.lazyRelease;
    this.lazyRelease = null;
    release?.();
  }

  /** Cancel the persistent-rejoin fallback timer if one is scheduled. Safe to call more than once. */
  clearRejoinTimer(): void {
    if (this.rejoinTimer !== null) {
      clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }
  }

  /** Mark active and tell `onSubscribed` listeners who started it. */
  markSubscribed(source: SubscribeSource): void {
    // A duplicate confirmation for an already-live subscription (e.g. a
    // server-source ack racing the client's own) must not re-fire onSubscribed.
    // A reconnect rejoin is let through so it can re-confirm.
    if (this.active && !this.rejoining) return;
    this.active = true;
    this.rejoining = false;
    this.pendingSubscribeFrame = null;
    this.clearRejoinTimer();
    // Resolve a waiting subscribe() on either ack: both a client-initiated and a
    // server-initiated confirmation mean the subscription is now live.
    if (this.pending) {
      this.pending.resolve();
      this.pending = null;
      this.pendingPromise = null;
    }
    this.subscribed.each((callback) => callback(source));
  }

  /** True while a `subscribe()` is waiting for its confirmation. */
  get hasPendingSubscribe(): boolean {
    return this.pending !== null;
  }

  /**
   * Fail a `subscribe()` whose held frame could never be sent (e.g. it can't
   * serialize on flush). Rejects the waiting promise and releases the hold so the
   * subscription doesn't sit pending forever.
   */
  failPendingSubscribe(error: unknown): void {
    if (!this.pending) return;
    this.pending.reject(error);
    this.pending = null;
    this.pendingPromise = null;
    this.pendingSubscribeFrame = null;
    this.releaseLazy();
  }

  /** Mark inactive, clear members, and tell `onUnsubscribed` listeners. */
  markUnsubscribed(): void {
    this.active = false;
    this.rejoining = false;
    this.pendingSubscribeFrame = null;
    this.pendingUnsubscribeFrame = null;
    this.clearRejoinTimer();
    this.members.clear();
    this.priorMembers = null;
    // The subscription ended (unsubscribed or kicked) — release the idle-prevention
    // hold and clear any in-flight subscribe(), so a later subscribe() starts fresh
    // rather than reusing the stale pending state.
    this.releaseLazy();
    this.pending?.reject(new Error('[wskit] unsubscribed before the subscribe was confirmed'));
    this.pending = null;
    this.pendingPromise = null;
    this.unsubscribed.each((callback) => callback());
  }

  fireKicked(reason: string): void {
    this.kicked.each((callback) => callback(reason));
  }

  fireSubscriptionFailed(error: WSKitError): void {
    const subscriptionFailed = this.pending !== null || this.rejoining;
    if (subscriptionFailed) this.releaseLazy();
    this.pendingSubscribeFrame = null;
    this.clearRejoinTimer();
    // Only deactivate the channel if a subscribe was actually in flight: either a
    // live subscribe() call (pending !== null) or a reconnect rejoin (rejoining).
    // A channel __error__ outside that window is a message error — leave the channel
    // active so one bad send doesn't drop the subscription.
    if (subscriptionFailed) {
      this.active = false;
      this.persistent = false;
      this.rejoining = false;
      this.members.clear();
      this.priorMembers = null;
    }
    // If there's a live subscribe() promise, reject it. Otherwise fire the failure event.
    if (this.pending) {
      this.pending.reject(error);
      this.pending = null;
      this.pendingPromise = null;
    } else {
      this.subFailed.each((callback) => callback(error));
    }
  }

  /**
   * Replace the whole member list (from `__memberSync__`). `onMemberJoin` fires
   * only for connections not already in the roster, `onMemberLeave` for ones that
   * dropped out, and `onMemberOnline` for everyone in the snapshot. On a reconnect
   * (where the prior roster was stashed by `clearMembersForReconnect`) this means
   * an unchanged peer is reported online again but not re-joined.
   */
  syncMembers(members: { connectionId: string; meta?: Record<string, unknown> }[]): void {
    const prev = this.priorMembers ?? new Set(this.members.keys());
    this.priorMembers = null;
    const next = new Set<string>();
    this.members.clear();
    for (const { connectionId, meta } of members) {
      next.add(connectionId);
      const member: ChannelMember = { meta: meta ?? {} };
      this.members.set(connectionId, member);
      if (!prev.has(connectionId))
        this.memberJoin.each((callback) => callback(connectionId, member));
      this.memberOnline.each((callback) => callback(connectionId, member));
    }
    for (const connectionId of prev) {
      if (!next.has(connectionId)) this.memberLeave.each((callback) => callback(connectionId));
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

  /** Clear members but keep the subscription (used on a network drop). The prior
   * roster is stashed so the post-reconnect `__memberSync__` reports only deltas. */
  clearMembersForReconnect(): void {
    // Only stash on the first drop. A second drop before the post-reconnect
    // __memberSync__ refills members would otherwise overwrite the real roster
    // with an empty set, making the next sync re-fire onMemberJoin for unchanged
    // peers. The reset paths (markUnsubscribed, fireSubscriptionFailed, syncMembers)
    // null priorMembers, so this re-arms on a genuine resubscribe.
    this.priorMembers ??= new Set(this.members.keys());
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

  /** @param log logger used to report a throwing event handler. */
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
