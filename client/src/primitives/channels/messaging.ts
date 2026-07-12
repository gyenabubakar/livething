import { ChannelNotSubscribed } from '@wskit/core';
import { Disconnected } from '~/errors.ts';
import { applyAugmenters } from '~/internal/scoped.ts';
import { familyKeyError, isReservedEventName, wireIdError } from '~/internal/wire-validation.ts';
import type { PrimitiveHelpers, SendResult } from '~/internal/runtime.ts';
import type { MessagingObject, ScopeMarkers } from '~/internal/scoped.ts';
import type { ChannelState, FamilyState } from '~/primitives/channels/state.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

/**
 * The shared context passed to the messaging and family-handle builders.
 * It gives them access to the socket, helpers, and state lookups without
 * them needing to manage those stores themselves.
 */
export interface ChannelContext {
  socket: WSKitSocket;
  helpers: PrimitiveHelpers;
  resolveTtl(event: string): number | undefined;
  /** Get (or create) the messaging for one channel — cached, so the same name returns the same object. */
  messagingFor(name: string, familyKey?: string): MessagingObject;
  /** Get (or create) the family-level state for a dynamic family. */
  family(familyKey: string): FamilyState;
  /** The concrete names currently active in a family. */
  listFamily(familyKey: string): string[];
}

/**
 * The `__<id>::` prefix a plugin-owned channel puts on its child event names. A
 * plugin owns its channel's events under its namespace, so both directions carry
 * the prefix: outgoing sends add it, incoming frames strip it. The source is the
 * family KEY for a dynamic member (whose channel name is a plain instance value),
 * else the channel name; it is `''` for a non-plugin channel or one with no `::`.
 */
export function channelEventPrefix(channelName: string, familyKey: string | undefined): string {
  const source = familyKey ?? channelName;
  if (!source.startsWith('__')) return '';
  const delimAt = source.indexOf('::');
  return delimAt < 0 ? '' : source.slice(0, delimAt + 2);
}

/** The routing fields (`__wskit`) that identify this channel on outgoing frames. */
export function channelMarkers(state: ChannelState): ScopeMarkers {
  // Use an explicit absence check, not truthiness: a supplied family key is always
  // included so the frame stays a family-scoped channel. (An empty key is rejected
  // before a channel is built, so a present key here is real.)
  return state.familyKey !== undefined
    ? { channel: state.name, channelFamily: state.familyKey }
    : { channel: state.name };
}

/** Build the handle a developer interacts with for one channel. */
export function buildChannelMessaging(
  context: ChannelContext,
  state: ChannelState,
): MessagingObject {
  const { helpers } = context;

  // A plugin-owned channel namespaces its child event names on the way out, the
  // mirror of the incoming strip; a plain app channel gets '' and is unchanged.
  const eventPrefix = channelEventPrefix(state.name, state.familyKey);

  // `markers()` returns the routing fields stamped on every outgoing frame.
  // `assertReady` throws if the channel isn't subscribed yet — all sending methods
  // (including request/sendWithAck/stream added by other primitives) call it first.
  function markers(): ScopeMarkers {
    return channelMarkers(state);
  }
  function assertReady(): void {
    if (!state.active) throw ChannelNotSubscribed();
  }

  const messaging: MessagingObject = {
    on(event, handler) {
      helpers.lazyAcquire();
      const remove = state.addHandler(event, handler);
      // Guard so calling this unsubscribe more than once releases the lazy hold
      // only once — a second call must not steal another listener's hold.
      let released = false;
      return () => {
        if (released) return;
        released = true;
        remove();
        helpers.lazyRelease();
      };
    },
    send(event, payload, options) {
      assertReady();
      // A reserved protocol name (ping/pong or the __ namespace) can't be a user
      // event — the server drops it, so don't put it on the wire. Check the plain
      // name; the plugin prefix is added only after it passes.
      if (isReservedEventName(event)) return false;
      const ttl = options?.ttl ?? context.resolveTtl(event);
      const result = helpers.send(
        { event: eventPrefix + event, payload, __wskit: markers() },
        ttl !== undefined ? { ttl } : undefined,
      );
      return result === 'sent' || result === 'buffered';
    },
    subscribe(data?: unknown) {
      // Reject an empty/over-limit name or family locally — the server rejects the
      // frame before it can route a channel error back to settle this Promise.
      const nameError =
        wireIdError('__subscribe__', state.name, 'channel') ??
        familyKeyError('__subscribe__', state.familyKey);
      if (nameError) return Promise.reject(nameError);

      helpers.ensureConnected();

      if (state.active) return Promise.resolve();

      // If subscribe() is called again before the server replies, return the same
      // promise instead of sending a second __subscribe__ and abandoning the first.
      if (state.pending && state.pendingPromise) return state.pendingPromise;

      // Prevent the socket from going idle while subscribed. This hold is released
      // on any ending path — unsubscribe, kick, or a failed subscribe — so it
      // never leaks even if the caller never explicitly unsubscribes.
      state.holdLazy(
        () => helpers.lazyAcquire(),
        () => helpers.lazyRelease(),
      );

      state.subscribeData = data;

      const promise = new Promise<void>((resolve, reject) => {
        state.pending = { resolve, reject };
      });

      state.pendingPromise = promise;
      state.markSubscribing();
      const thisPending = state.pending;
      void promise.catch(() => undefined);

      // Settle and tear down once; the identity guard stops a stale failure (an
      // old payload promise rejecting after a newer subscribe) clobbering the new one.
      function failSubscribe(error: unknown): void {
        if (state.pending !== thisPending) return;
        thisPending?.reject(error);
        state.pending = null;
        state.pendingPromise = null;
        state.pendingSubscribeFrame = null;
        state.releaseLazy();
      }

      function sendSubscribe(resolved: unknown): void {
        if (state.pending !== thisPending) return;
        state.resolvedSubscribeData = resolved;
        const frame = {
          event: '__subscribe__',
          payload: resolved ?? {},
          __wskit: channelMarkers(state),
        };
        let result: SendResult;
        try {
          result = helpers.rawSend(frame);
        } catch (error) {
          // A non-serializable frame must not leak the installed pending state.
          failSubscribe(error);
          return;
        }
        if (result === 'connecting') {
          state.pendingSubscribeFrame = frame;
        } else if (result === 'closed') {
          // Closed, non-lazy: nothing will flush this — fail fast, don't hang.
          failSubscribe(Disconnected());
        }
      }

      // Resolve the payload (running a function payload fresh each time) and send.
      // Re-runnable so it can be deferred behind a leave and replayed after a
      // reconnect with a freshly-produced payload (e.g. a rotating auth token).
      function resolveAndSend(): void {
        if (typeof data === 'function') {
          // A synchronous factory throw escapes Promise.resolve — guard the call too.
          let factoryResult: unknown;
          try {
            factoryResult = (data as () => unknown)();
          } catch (error) {
            failSubscribe(error);
            return;
          }
          void Promise.resolve(factoryResult).then(sendSubscribe, failSubscribe);
        } else {
          sendSubscribe(data);
        }
      }

      // A subscribe issued while a leave is still in flight waits for the leave's
      // confirmation, so the re-join lands after the leave on the wire — and is
      // re-run then, picking up a fresh payload.
      if (state.pendingLeave !== null) {
        state.deferredSubscribe = resolveAndSend;
      } else {
        resolveAndSend();
      }

      return promise;
    },
    unsubscribe(): Promise<void> {
      if (!state.active && !state.pending && !state.pendingLeave) return Promise.resolve();

      // A leave is already outstanding: the latest intent is to leave, so drop
      // any re-subscribe queued behind it and share the same promise.
      if (state.pendingLeave) {
        if (state.deferredSubscribe) {
          state.deferredSubscribe = null;
          state.failPendingSubscribe(new Error('[wskit] re-subscribe superseded by unsubscribe()'));
        }
        return state.beginLeave(state.pendingLeave.unsubscribeId);
      }

      // Leave locally right away: the channel goes inactive (so send() throws),
      // members clear, any in-flight subscribe() rejects, and onUnsubscribed fires.
      // The leave op below confirms the leave actually reached the server.
      state.markUnsubscribed();
      if (state.familyKey) context.family(state.familyKey).fireUnsubscribed(state.name);

      const unsubscribeId = helpers.generateId('unsub');
      const promise = state.beginLeave(unsubscribeId);
      const result = helpers.rawSend({
        event: '__unsubscribe__',
        payload: {},
        __wskit: { ...channelMarkers(state), unsubscribeId },
      });
      // Closed with no reconnect coming — the leave can never be confirmed.
      if (result === 'closed') state.failLeave(Disconnected());
      // 'connecting' keeps the leave pending; onOpen resends it on reopen.
      return promise;
    },
    resyncMembers(): void {
      if (!state.active) return;
      helpers.rawSend({
        event: '__memberSync__',
        payload: {},
        __wskit: { ...channelMarkers(state), source: 'client' },
      });
    },
    members: state.members,
    status: state.status,
    onMemberJoin: state.onMemberJoin,
    onMemberLeave: state.onMemberLeave,
    onMemberOnline: state.onMemberOnline,
    onMemberOffline: state.onMemberOffline,
    onSubscribed: state.onSubscribed,
    onUnsubscribed: state.onUnsubscribed,
    onKicked: state.onKicked,
    onSubscriptionFailed: state.onSubscriptionFailed,
    // Overridden by replay()'s augmenter; the type exposes it without replay(), so fail loudly here.
    onGap(): () => void {
      throw new Error(
        '[wskit] channel.onGap needs the replay() primitive — add replay() to client().',
      );
    },
  };

  applyAugmenters(context.socket, messaging, {
    markers,
    assertReady,
    // On a plugin channel the request/stream/onStream/resumeStream augmenters
    // namespace their event names too, symmetric with `send`; a plain app channel
    // gets no prefixName and leaves names bare.
    prefixName: eventPrefix ? (name) => eventPrefix + name : undefined,
  });
  return messaging;
}

/** The runtime type of a family handle: a callable function with family-level listener methods. */
export type FamilyHandle = ((name: string) => MessagingObject) & {
  on(event: string, handler: (data: unknown, channelName: string) => void): () => void;
  onSubscribed(callback: (channelName: string, source: 'server' | 'client') => void): () => void;
  onUnsubscribed(callback: (channelName: string) => void): () => void;
  list(): string[];
};

/** Build the callable handle for a whole dynamic channel family. */
export function buildFamilyHandle(context: ChannelContext, familyKey: string): FamilyHandle {
  const family = context.family(familyKey);
  const handle = ((name: string) => context.messagingFor(name, familyKey)) as FamilyHandle;
  handle.on = (event, handler) => family.addHandler(event, handler);
  handle.onSubscribed = (callback) => family.onSubscribed(callback);
  handle.onUnsubscribed = (callback) => family.onUnsubscribed(callback);
  handle.list = () => context.listFamily(familyKey);
  return handle;
}
