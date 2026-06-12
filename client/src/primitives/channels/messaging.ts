import { ChannelNotSubscribed } from '@wskit/core';
import { applyAugmenters } from '~/internal/scoped.ts';
import type { PrimitiveHelpers } from '~/internal/runtime.ts';
import type { MessagingObject, ScopeMarkers } from '~/internal/scoped.ts';
import type { ChannelState, FamilyState } from '~/primitives/channels/state.ts';
import type { ChannelMember } from '~/primitives/channels/types.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

/**
 * The shared context passed to the messaging and scope-handle builders.
 * It gives them access to the socket, helpers, and state lookups without
 * them needing to manage those stores themselves.
 */
export interface ChannelContext {
  socket: WSKitSocket;
  helpers: PrimitiveHelpers;
  resolveTtl(event: string): number | undefined;
  /** Get (or create) the messaging for one channel — cached, so the same name returns the same object. */
  messagingFor(name: string, scopeKey?: string): MessagingObject;
  /** Get (or create) the family-level state for a dynamic family. */
  family(scopeKey: string): FamilyState;
  /** The concrete names currently active in a family. */
  listFamily(scopeKey: string): string[];
}

/** The routing fields (`__wskit`) that identify this channel on outgoing frames. */
export function channelMarkers(state: ChannelState): ScopeMarkers {
  return state.scopeKey
    ? { channel: state.name, channelScope: state.scopeKey }
    : { channel: state.name };
}

/** Build the handle a developer interacts with for one channel. */
export function buildChannelMessaging(
  context: ChannelContext,
  state: ChannelState,
): MessagingObject {
  const { helpers } = context;

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
      const ttl = options?.ttl ?? context.resolveTtl(event);
      return helpers.send(
        { event, payload, __wskit: markers() },
        ttl !== undefined ? { ttl } : undefined,
      );
    },
    subscribe(data?: unknown) {
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
      const thisPending = state.pending;
      void promise.catch(() => undefined);

      function sendSubscribe(resolved: unknown): void {
        if (state.pending !== thisPending) return;
        state.resolvedSubscribeData = resolved;
        const frame = {
          event: '__subscribe__',
          payload: resolved ?? {},
          __wskit: channelMarkers(state),
        };
        const connectionState = helpers.getState();
        if (connectionState === 'connecting' || connectionState === 'reconnecting') {
          state.pendingSubscribeFrame = frame;
        } else {
          helpers.rawSend(frame);
        }
      }

      if (typeof data === 'function') {
        // Call the function to get the payload, then send. Plain values go through
        // the synchronous path below. If the function throws, reject the subscribe promise.
        void Promise.resolve((data as () => unknown)()).then(sendSubscribe, (err) => {
          state.pending?.reject(err);
          state.pending = null;
          state.pendingPromise = null;
          state.releaseLazy();
        });
      } else {
        sendSubscribe(data);
      }

      return promise;
    },
    unsubscribe() {
      // If the channel was never subscribed (and no subscribe is in flight),
      // do nothing — don't send __unsubscribe__ or fire onUnsubscribed.
      if (!state.active && !state.pending) return;
      helpers.rawSend({ event: '__unsubscribe__', payload: {}, __wskit: channelMarkers(state) });
      // markUnsubscribed() releases the idle-prevention hold for us.
      state.markUnsubscribed();
      if (state.scopeKey) context.family(state.scopeKey).fireUnsubscribed(state.name);
    },
    get members(): ReadonlyMap<string, ChannelMember> {
      return state.members;
    },
    onMemberJoin: state.onMemberJoin,
    onMemberLeave: state.onMemberLeave,
    onMemberOnline: state.onMemberOnline,
    onMemberOffline: state.onMemberOffline,
    onSubscribed: state.onSubscribed,
    onUnsubscribed: state.onUnsubscribed,
    onKicked: state.onKicked,
    onSubscriptionFailed: state.onSubscriptionFailed,
  };

  applyAugmenters(context.socket, messaging, { markers, assertReady });
  return messaging;
}

/** The runtime type of a scope handle: a callable function with family-level listener methods. */
export type ScopeHandleObject = ((name: string) => MessagingObject) & {
  on(event: string, handler: (data: unknown, channelName: string) => void): () => void;
  onSubscribed(callback: (channelName: string, source: 'server' | 'client') => void): () => void;
  onUnsubscribed(callback: (channelName: string) => void): () => void;
  list(): string[];
};

/** Build the callable handle for a whole dynamic channel family. */
export function buildScopeHandle(context: ChannelContext, scopeKey: string): ScopeHandleObject {
  const family = context.family(scopeKey);
  const handle = ((name: string) => context.messagingFor(name, scopeKey)) as ScopeHandleObject;
  handle.on = (event, handler) => family.addHandler(event, handler);
  handle.onSubscribed = (callback) => family.onSubscribed(callback);
  handle.onUnsubscribed = (callback) => family.onUnsubscribed(callback);
  handle.list = () => context.listFamily(scopeKey);
  return handle;
}
