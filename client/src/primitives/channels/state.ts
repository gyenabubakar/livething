import { dispatchToHandlers } from '~/internal/dispatch.ts';
import { createStore } from '~/internal/store.ts';
import { channelEventPrefix } from '~/primitives/channels/messaging.ts';
import type { LiveThingError } from '@livething/core';
import type { Message, PrimitiveLogger } from '~/internal/runtime.ts';
import type { ReadableStore } from '~/internal/store.ts';
import type { ChannelMember, ChannelStatus, SubscribeSource } from '~/primitives/channels/types.ts';

type Handler = (data: unknown) => void;
type MemberCallback = (memberId: string, member: ChannelMember) => void;
type LeaveCallback = (memberId: string) => void;

/** One entry of a `__memberChanges__` frame. */
export interface MemberChange {
  kind: 'join' | 'leave' | 'online' | 'offline';
  memberId: string;
  meta?: Record<string, unknown>;
}

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
  pendingSubscribeFrame: Message | null = null;
  /**
   * An outstanding leave waiting for the server's `__unsubscribeOk__`. Carries
   * the `unsubscribeId` the confirmation must echo. While set it is resent on
   * every reopen (so a leave lost to a drop still completes) and any server
   * auto-rejoin `__subscribeOk__` is ignored — the user asked to leave, and that
   * wins until the server confirms.
   */
  pendingLeave: {
    unsubscribeId: string;
    resolve: () => void;
    reject: (err: unknown) => void;
  } | null = null;
  /** The in-flight `unsubscribe()` promise, reused so overlapping calls share one. */
  pendingLeavePromise: Promise<void> | null = null;
  /**
   * A `subscribe()` issued while a leave is still pending: held here and run once
   * the leave is confirmed, so the re-join lands after the leave on the wire.
   */
  deferredSubscribe: (() => void) | null = null;
  /** Releases the idle-prevention hold taken by `subscribe()`. Held until the subscription ends. */
  private lazyRelease: (() => void) | null = null;
  /** Handle for the persistent-rejoin fallback re-subscribe timer, so it can be cancelled. */
  rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  /** Roster captured at a network drop, so the next `__memberSync__` can fire only real deltas. */
  private priorMembers: ReadonlyMap<string, ChannelMember> | null = null;

  private readonly roster = new Map<string, ChannelMember>();
  readonly handlers = new Map<string, Set<Handler>>();

  private readonly membersStore = createStore<ReadonlyMap<string, ChannelMember>>(
    new Map(),
    (error) => this.log.report(error),
  );
  /**
   * The member roster as a reactive store. Every join, leave, or sync publishes a
   * fresh snapshot, so `members.get()` is safe to compare by reference.
   */
  readonly members: ReadableStore<ReadonlyMap<string, ChannelMember>> = this.membersStore.store;

  private readonly statusStore = createStore<ChannelStatus>('unsubscribed', (error) =>
    this.log.report(error),
  );
  /** The subscription state as a reactive store. */
  readonly status: ReadableStore<ChannelStatus> = this.statusStore.store;

  private readonly subscribed = listeners<(source: SubscribeSource) => void>(() => this.log);
  private readonly unsubscribed = listeners<() => void>(() => this.log);
  private readonly kicked = listeners<(reason: string) => void>(() => this.log);
  private readonly subFailed = listeners<(error: LiveThingError) => void>(() => this.log);
  private readonly memberJoin = listeners<MemberCallback>(() => this.log);
  private readonly memberLeave = listeners<LeaveCallback>(() => this.log);
  private readonly memberOnline = listeners<MemberCallback>(() => this.log);
  private readonly memberOffline = listeners<LeaveCallback>(() => this.log);

  constructor(
    /** The channel metadata name value. */
    readonly name: string,
    /** The channel metadata family value, for a channel inside a dynamic family. */
    readonly familyKey: string | undefined,
    /** Debug-gated logger, used to report a throwing event handler. */
    private readonly log: PrimitiveLogger,
  ) {
    this.eventPrefix = channelEventPrefix(name, familyKey);
  }

  /**
   * The `__<id>::` prefix this channel's child events carry, or `''`. Fixed for
   * the channel's lifetime, so it is resolved once here rather than on every
   * frame the channel routes.
   */
  readonly eventPrefix: string;

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

  /** Publish the current roster as a fresh immutable snapshot to the members store. */
  private publishMembers(): void {
    this.membersStore.set(new Map(this.roster));
  }

  /** Move the subscription to a new state and publish it to the status store. */
  private setStatus(next: ChannelStatus): void {
    this.statusStore.set(next);
  }

  /** Mark that a `subscribe()` — or a reconnect rejoin — is now in flight. */
  markSubscribing(): void {
    this.setStatus('subscribing');
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

    this.setStatus('subscribed');
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
    this.setStatus('failed');
  }

  /**
   * Open a leave op, or return the promise of one already in flight. Repeat
   * `unsubscribe()` calls share the same promise and reuse the same id.
   */
  beginLeave(unsubscribeId: string): Promise<void> {
    if (this.pendingLeavePromise) return this.pendingLeavePromise;

    const promise = new Promise<void>((resolve, reject) => {
      this.pendingLeave = { unsubscribeId, resolve, reject };
    });
    this.pendingLeavePromise = promise;
    // Pre-attach a no-op catch so an unobserved rejection (caller ignored the
    // returned promise) never surfaces as an unhandled rejection.
    void promise.catch(() => undefined);

    return promise;
  }

  /**
   * Settle the leave when the matching `__unsubscribeOk__` arrives, then run a
   * `subscribe()` that was queued behind it. A confirmation whose id doesn't
   * match the outstanding leave (a stale one from an earlier connection) is
   * ignored.
   */
  confirmLeave(unsubscribeId: string): { rejoinPending: boolean } | null {
    const leave = this.pendingLeave;
    if (!leave || leave.unsubscribeId !== unsubscribeId) return null;

    this.pendingLeave = null;
    this.pendingLeavePromise = null;
    leave.resolve();

    const deferred = this.deferredSubscribe;
    this.deferredSubscribe = null;
    const rejoinPending = deferred !== null;
    deferred?.();

    return { rejoinPending };
  }

  /**
   * Abandon an outstanding leave (and any subscribe queued behind it) because
   * the socket will never confirm it — a permanent reconnect failure or an
   * intentional disconnect.
   */
  failLeave(error: unknown): void {
    const leave = this.pendingLeave;
    this.pendingLeave = null;
    this.pendingLeavePromise = null;
    this.deferredSubscribe = null;
    leave?.reject(error);
    // A subscribe queued behind the leave can't proceed either.
    this.failPendingSubscribe(error);
  }

  /** Mark inactive, clear members, and tell `onUnsubscribed` listeners. */
  markUnsubscribed(): void {
    this.active = false;
    this.rejoining = false;
    this.pendingSubscribeFrame = null;
    this.clearRejoinTimer();
    this.roster.clear();

    this.publishMembers();
    this.priorMembers = null;
    // The subscription ended (unsubscribed or kicked) — release the idle-prevention
    // hold and clear any in-flight subscribe(), so a later subscribe() starts fresh
    // rather than reusing the stale pending state.
    this.releaseLazy();
    this.pending?.reject(new Error('[livething] unsubscribed before the subscribe was confirmed'));
    this.pending = null;
    this.pendingPromise = null;
    this.setStatus('unsubscribed');

    this.unsubscribed.each((callback) => callback());
  }

  fireKicked(reason: string): void {
    this.kicked.each((callback) => callback(reason));
  }

  /**
   * True while a live `subscribe()` call or a reconnect rejoin waits for its
   * answer. Only a channel `__error__` in this window is a subscription failure.
   */
  get hasSubscribeInFlight(): boolean {
    return this.pending !== null || this.rejoining;
  }

  /** Fail the in-flight subscribe or rejoin. Call only while `hasSubscribeInFlight`. */
  fireSubscriptionFailed(error: LiveThingError): void {
    this.releaseLazy();
    this.pendingSubscribeFrame = null;
    this.clearRejoinTimer();
    this.active = false;
    this.persistent = false;

    this.rejoining = false;
    this.roster.clear();
    this.publishMembers();
    this.priorMembers = null;
    this.setStatus('failed');

    if (this.pending) {
      this.pending.reject(error);
      this.pending = null;
      this.pendingPromise = null;
    } else {
      this.subFailed.each((callback) => callback(error));
    }
  }

  /**
   * Replace the whole member list (from `__memberSync__`) and fire only what
   * changed against the prior roster (the one stashed by
   * `clearMembersForReconnect` on a reconnect): `onMemberJoin` for a new
   * member, then `onMemberOnline` if it is online; `onMemberOnline` or
   * `onMemberOffline` for a known member whose online state flipped; and
   * `onMemberLeave` for a member no longer listed, then `onMemberOffline` if it
   * was online (the server's live order).
   */
  syncMembers(
    members: { memberId: string; meta?: Record<string, unknown>; online: boolean }[],
  ): void {
    const prev = this.priorMembers ?? new Map(this.roster);
    this.priorMembers = null;
    const next = new Map<string, ChannelMember>();
    for (const { memberId, meta, online } of members) {
      next.set(memberId, { meta: meta ?? {}, online });
    }

    this.roster.clear();
    for (const [memberId, member] of next) this.roster.set(memberId, member);
    this.publishMembers();

    for (const [memberId, member] of next) {
      const before = prev.get(memberId);
      if (!before) this.memberJoin.each((callback) => callback(memberId, member));

      if (member.online && !before?.online) {
        this.memberOnline.each((callback) => callback(memberId, member));
      } else if (!member.online && before?.online) {
        this.memberOffline.each((callback) => callback(memberId));
      }
    }

    for (const [memberId, before] of prev) {
      if (next.has(memberId)) continue;

      this.memberLeave.each((callback) => callback(memberId));
      if (before.online) this.memberOffline.each((callback) => callback(memberId));
    }
  }

  /**
   * Apply a `__memberChanges__` batch in order. The roster is published once, after every
   * change is in, and then the callbacks fire in order, so a callback reads the roster as it
   * is after the whole batch.
   */
  applyMemberChanges(changes: readonly MemberChange[]): void {
    const callbacks: (() => void)[] = [];
    let changed = false;
    for (const change of changes) {
      const { memberId } = change;
      const known = this.roster.get(memberId);
      switch (change.kind) {
        case 'join': {
          // A new member counts as offline until its `online` change.
          const member: ChannelMember = { meta: change.meta ?? {}, online: known?.online ?? false };
          this.roster.set(memberId, member);
          changed = true;
          callbacks.push(() => this.memberJoin.each((callback) => callback(memberId, member)));
          break;
        }

        case 'leave':
          changed = this.roster.delete(memberId) || changed;
          callbacks.push(() => this.memberLeave.each((callback) => callback(memberId)));
          break;

        case 'online': {
          // A member id missing from the roster is not added.
          const member: ChannelMember = { meta: change.meta ?? known?.meta ?? {}, online: true };
          if (known) {
            this.roster.set(memberId, member);
            changed = true;
          }

          callbacks.push(() => this.memberOnline.each((callback) => callback(memberId, member)));
          break;
        }

        case 'offline':
          // It stays in the roster until it leaves.
          if (known?.online) {
            this.roster.set(memberId, { ...known, online: false });
            changed = true;
          }

          callbacks.push(() => this.memberOffline.each((callback) => callback(memberId)));
          break;
      }
    }

    if (changed) this.publishMembers();
    for (const callback of callbacks) {
      // A callback can unsubscribe. The rest of the batch then belongs to a channel we left.
      if (!this.active || this.pendingLeave) return;

      callback();
    }
  }

  /** Clear members but keep the subscription (used on a network drop). The prior
   * roster is stashed so the post-reconnect `__memberSync__` reports only deltas. */
  clearMembersForReconnect(): void {
    // Only stash on the first drop. A second drop before the post-reconnect
    // __memberSync__ refills members would otherwise overwrite the real roster
    // with an empty map, making the next sync re-fire onMemberJoin for unchanged
    // peers. The reset paths (markUnsubscribed, fireSubscriptionFailed, syncMembers)
    // null priorMembers, so this re-arms on a genuine resubscribe.
    this.priorMembers ??= new Map(this.roster);
    this.roster.clear();
    this.publishMembers();
  }
}

/**
 * Family-level state for a dynamic channel family (`socket.channel.family(key)`).
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
