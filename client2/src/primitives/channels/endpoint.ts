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
export function buildChannelEndpoint(ctx: ChannelContext, state: ChannelState): EndpointObject {
  const { helpers } = ctx;

  // Sending requires an active subscription; this also guards request/sendWithAck,
  // which the augmenters build on top of these markers.
  function markers(): ScopeMarkers {
    if (!state.active) throw ChannelNotSubscribed();
    return channelMarkers(state);
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
      const ttl = options?.ttl ?? ctx.resolveTtl(event);
      return helpers.send(
        { event, payload, __wskit: markers() },
        ttl !== undefined ? { ttl } : undefined,
      );
    },
    subscribe(data?: unknown) {
      helpers.ensureConnected();
      helpers.lazyAcquire();
      state.subscribeData = data;
      return new Promise<void>((resolve, reject) => {
        state.pending = { resolve, reject };
        helpers.rawSend({
          event: '__subscribe__',
          payload: data ?? {},
          __wskit: channelMarkers(state),
        });
      });
    },
    unsubscribe() {
      helpers.rawSend({ event: '__unsubscribe__', payload: {}, __wskit: channelMarkers(state) });
      state.markUnsubscribed();
      if (state.scopeKey) ctx.family(state.scopeKey).fireUnsubscribed(state.name);
      helpers.lazyRelease();
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

  applyAugmenters(ctx.socket, endpoint, { markers });
  return endpoint;
}

/** The runtime shape of a scope handle — callable, with family-level methods. */
export type ScopeHandleObject = ((name: string) => EndpointObject) & {
  on(event: string, handler: (data: unknown, channelName: string) => void): () => void;
  onSubscribed(cb: (channelName: string, source: 'server' | 'client') => void): () => void;
  onUnsubscribed(cb: (channelName: string) => void): () => void;
  list(): string[];
};

/** Build the callable handle for a whole dynamic channel family. */
export function buildScopeHandle(ctx: ChannelContext, scopeKey: string): ScopeHandleObject {
  const family = ctx.family(scopeKey);
  const handle = ((name: string) => ctx.endpointFor(name, scopeKey)) as ScopeHandleObject;
  handle.on = (event, handler) => family.addHandler(event, handler);
  handle.onSubscribed = (cb) => family.onSubscribed(cb);
  handle.onUnsubscribed = (cb) => family.onUnsubscribed(cb);
  handle.list = () => ctx.listFamily(scopeKey);
  return handle;
}
