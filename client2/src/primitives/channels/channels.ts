import { Disconnected } from '~/errors.ts';
import { toWSKitError } from '~/internal/error-frame.ts';
import {
  buildChannelMessaging,
  buildScopeHandle,
  channelMarkers,
} from '~/primitives/channels/messaging.ts';
import { channelKey, ChannelState, FamilyState } from '~/primitives/channels/state.ts';
import type { WireMessage } from '~/internal/runtime.ts';
import type { MessagingObject } from '~/internal/scoped.ts';
import type { ChannelContext, ScopeHandleObject } from '~/primitives/channels/messaging.ts';
import type {
  ChannelsOptions,
  ChannelsPrimitive,
  SubscribeSource,
} from '~/primitives/channels/types.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

/** Read a `{ connectionId, meta? }` payload defensively (it comes off the wire). */
function readMember(
  payload: unknown,
): { connectionId: string; meta?: Record<string, unknown> } | null {
  const fields = (payload ?? {}) as { connectionId?: unknown; meta?: unknown };
  if (typeof fields.connectionId !== 'string') return null;
  return {
    connectionId: fields.connectionId,
    meta: fields.meta as Record<string, unknown> | undefined,
  };
}

/**
 * Server-managed rooms. Unlike namespaces, a channel must be subscribed before
 * you can send or receive on it; the server tracks membership and scopes
 * broadcasts to subscribers. This primitive owns all the per-channel state —
 * subscriptions, members, presence — and routes the channel wire frames.
 */
export function channels(options: ChannelsOptions = {}): ChannelsPrimitive {
  return {
    _tag: 'channels',
    setup(helpers) {
      const states = new Map<string, ChannelState>();
      const cache = new Map<string, MessagingObject>();
      const families = new Map<string, FamilyState>();
      const scopeHandles = new Map<string, ScopeHandleObject>();
      let socket: WSKitSocket; // assigned in install, before any handle is built

      function resolveTtl(event: string): number | undefined {
        if (typeof options.ttl === 'number') return options.ttl;
        if (options.ttl) return options.ttl[event];
        return undefined;
      }

      function stateFor(name: string, scopeKey?: string): ChannelState {
        const key = channelKey(name, scopeKey);
        let state = states.get(key);
        if (!state) {
          state = new ChannelState(name, scopeKey, helpers.log);
          states.set(key, state);
        }
        return state;
      }

      function familyFor(scopeKey: string): FamilyState {
        let family = families.get(scopeKey);
        if (!family) {
          family = new FamilyState(helpers.log);
          families.set(scopeKey, family);
        }
        return family;
      }

      function listFamily(scopeKey: string): string[] {
        const names: string[] = [];
        for (const state of states.values()) {
          if (state.scopeKey === scopeKey && state.active) names.push(state.name);
        }
        return names;
      }

      const context: ChannelContext = {
        helpers,
        resolveTtl,
        family: familyFor,
        listFamily,
        get socket() {
          return socket;
        },
        messagingFor(name, scopeKey) {
          const key = channelKey(name, scopeKey);
          let messaging = cache.get(key);
          if (!messaging) {
            messaging = buildChannelMessaging(context, stateFor(name, scopeKey));
            cache.set(key, messaging);
          }
          return messaging;
        },
      };

      return {
        id: 'channels',
        onIncoming(message) {
          const wskit = message.__wskit;
          const name = wskit?.channel;
          if (typeof name !== 'string') return message; // not a channel frame

          const scopeKey = wskit?.channelScope;
          const state = stateFor(name, scopeKey);
          function notifyFamily(notify: (family: FamilyState) => void): void {
            if (scopeKey) notify(familyFor(scopeKey));
          }

          switch (message.event) {
            case '__subscribeOk__': {
              const source: SubscribeSource =
                (message.payload as { source?: unknown })?.source === 'server'
                  ? 'server'
                  : 'client';
              helpers.log.info(`channel '${name}' subscribed (${source})`);
              state.markSubscribed(source);
              notifyFamily((family) => family.fireSubscribed(name, source));
              return null;
            }
            case '__memberSync__': {
              const raw = (message.payload as { members?: unknown })?.members;
              const members = Array.isArray(raw)
                ? raw.map(readMember).filter((m) => m !== null)
                : [];
              state.syncMembers(members);
              return null;
            }
            case '__memberJoin__': {
              const member = readMember(message.payload);
              if (member) state.addMember(member.connectionId, member.meta);
              return null;
            }
            case '__memberLeave__': {
              const member = readMember(message.payload);
              if (member) state.removeMember(member.connectionId);
              return null;
            }
            case '__memberOnline__': {
              const member = readMember(message.payload);
              if (member) state.memberWentOnline(member.connectionId, member.meta);
              return null;
            }
            case '__memberOffline__': {
              const member = readMember(message.payload);
              if (member) state.memberWentOffline(member.connectionId);
              return null;
            }
            case '__kicked__': {
              const reason = (message.payload as { reason?: unknown })?.reason;
              state.fireKicked(typeof reason === 'string' ? reason : '');
              state.markUnsubscribed();
              notifyFamily((family) => family.fireUnsubscribed(name));
              return null;
            }
            case '__error__': {
              // A request/ack error carries its own id and belongs to that primitive.
              if (wskit?.correlationId !== undefined || wskit?.ackId !== undefined) return message;
              // A stream error carries a streamId and belongs to the stream primitive.
              if (wskit?.streamId !== undefined) return message;
              state.fireSubscriptionFailed(toWSKitError(message.payload));
              return null;
            }
            default: {
              // A normal channel event. Leave protocol frames and request replies alone.
              if (message.event.startsWith('__')) return message;
              if (wskit?.correlationId !== undefined) return message;
              // A channel-scoped stream chunk carries a streamId — it belongs to
              // the stream primitive, not channel.on(). Pass it through untouched.
              if (wskit?.streamId !== undefined) return message;
              helpers.log.info(`routing '${message.event}' to channel '${name}'`);
              state.dispatch(message.event, message.payload);
              notifyFamily((family) => family.dispatch(message.event, message.payload, name));
              return message;
            }
          }
        },
        onReconnect() {
          // Re-join every channel we were subscribed to. The server confirms with
          // __subscribeOk__ (and a fresh __memberSync__ repopulates members).
          const resubscribes: WireMessage[] = [];
          for (const state of states.values()) {
            if (state.active) {
              resubscribes.push({
                event: '__subscribe__',
                payload: state.subscribeData ?? {},
                __wskit: channelMarkers(state),
              });
            }
          }
          return resubscribes.length ? resubscribes : null;
        },
        onClose() {
          // A drop clears members and fails any in-flight subscribe, but keeps the
          // channel in the active set so it re-subscribes on reconnect.
          for (const state of states.values()) {
            if (state.pending) {
              state.pending.reject(Disconnected());
              state.pending = null;
              state.pendingPromise = null;
            }
            state.clearMembersForReconnect();
          }
        },
        install(installedSocket) {
          socket = installedSocket;

          function channel(nameOrScope: string, name?: string): MessagingObject {
            return name === undefined
              ? context.messagingFor(nameOrScope)
              : context.messagingFor(name, nameOrScope);
          }
          channel.scope = (scopeKey: string): ScopeHandleObject => {
            let handle = scopeHandles.get(scopeKey);
            if (!handle) {
              handle = buildScopeHandle(context, scopeKey);
              scopeHandles.set(scopeKey, handle);
            }
            return handle;
          };

          // @ts-expect-error — install adds channel() to the socket dynamically
          installedSocket.channel = channel;
        },
      };
    },
  };
}
