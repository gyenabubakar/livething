import { ChannelNotSubscribed } from '@wskit/core';
import { applyAugmenters } from '~/internal/scoped.ts';
import type { PrimitiveHelpers } from '~/internal/runtime.ts';
import type { EndpointObject, ScopeMarkers } from '~/internal/scoped.ts';
import type { ChannelState, FamilyState } from '~/primitives/channels/state.ts';
import type { ChannelMember } from '~/primitives/channels/types.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

/**
 * The bits of the channels primitive that the endpoint and scope-handle builders
 * need. `index.ts` owns the stores and hands this in, so the builders stay free
 * of bookkeeping.
 */
export interface ChannelContext {
  socket: WSKitSocket;
  helpers: PrimitiveHelpers;
  resolveTtl(event: string): number | undefined;
  /** Get (or create) the endpoint for one channel — cached, so the same name returns the same object. */
  endpointFor(name: string, scopeKey?: string): EndpointObject;
  /** Get (or create) the family-level state for a dynamic family. */
  family(scopeKey: string): FamilyState;
  /** The concrete names currently active in a family. */
  listFamily(scopeKey: string): string[];
}

/** The `__wskit` markers for a channel, with no active-state check (used by subscribe/unsubscribe/reconnect). */
export function channelMarkers(state: ChannelState): ScopeMarkers {
  return state.scopeKey
    ? { channel: state.name, channelScope: state.scopeKey }
    : { channel: state.name };
}

/** Build the handle a developer interacts with for one channel. */
export function buildChannelEndpoint(context: ChannelContext, state: ChannelState): EndpointObject {
  const { helpers } = context;

  // Sending needs an active subscription. `markers()` is the plain identity (used
  // for routing and listen-only methods); `assertReady` is the guard the sending
  // methods — including augmenter-built request/sendWithAck/stream — call first.
  function markers(): ScopeMarkers {
    return channelMarkers(state);
  }
  function assertReady(): void {
    if (!state.active) throw ChannelNotSubscribed();
  }

  const endpoint: EndpointObject = {
    on(event, handler) {
      helpers.lazyAcquire();
      const remove = state.addHandler(event, handler);
      return () => {
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
      // An overlapping subscribe() before the server confirms reuses the in-flight
      // promise instead of orphaning the first and re-sending __subscribe__.
      if (state.pending && state.pendingPromise) return state.pendingPromise;
      // Keep the (lazy) socket awake for the subscription's lifetime. The state
      // drops this hold on any end — unsubscribe, kick, or a failed subscribe —
      // not just an explicit unsubscribe(), so it can't leak.
      state.holdLazy(
        () => helpers.lazyAcquire(),
        () => helpers.lazyRelease(),
      );
      state.subscribeData = data;
      const promise = new Promise<void>((resolve, reject) => {
        state.pending = { resolve, reject };
        helpers.rawSend({
          event: '__subscribe__',
          payload: data ?? {},
          __wskit: channelMarkers(state),
        });
      });
      state.pendingPromise = promise;
      return promise;
    },
    unsubscribe() {
      // Nothing to leave — a channel that was never subscribed (and has no
      // in-flight subscribe) must not send a spurious __unsubscribe__ or fire
      // onUnsubscribed.
      if (!state.active && !state.pending) return;
      helpers.rawSend({ event: '__unsubscribe__', payload: {}, __wskit: channelMarkers(state) });
      // markUnsubscribed() drops the lazy hold for us.
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

  applyAugmenters(context.socket, endpoint, { markers, assertReady });
  return endpoint;
}

/** The runtime shape of a scope handle — callable, with family-level methods. */
export type ScopeHandleObject = ((name: string) => EndpointObject) & {
  on(event: string, handler: (data: unknown, channelName: string) => void): () => void;
  onSubscribed(callback: (channelName: string, source: 'server' | 'client') => void): () => void;
  onUnsubscribed(callback: (channelName: string) => void): () => void;
  list(): string[];
};

/** Build the callable handle for a whole dynamic channel family. */
export function buildScopeHandle(context: ChannelContext, scopeKey: string): ScopeHandleObject {
  const family = context.family(scopeKey);
  const handle = ((name: string) => context.endpointFor(name, scopeKey)) as ScopeHandleObject;
  handle.on = (event, handler) => family.addHandler(event, handler);
  handle.onSubscribed = (callback) => family.onSubscribed(callback);
  handle.onUnsubscribed = (callback) => family.onUnsubscribed(callback);
  handle.list = () => context.listFamily(scopeKey);
  return handle;
}
