import { Disconnected } from '~/errors.ts';
import { channelKey } from '~/internal/channel-key.ts';
import { toWSKitError } from '~/internal/error-frame.ts';
import {
  buildChannelMessaging,
  buildScopeHandle,
  channelMarkers,
} from '~/primitives/channels/messaging.ts';
import { ChannelState, FamilyState } from '~/primitives/channels/state.ts';
import type { WireMessage } from '~/internal/runtime.ts';
import type { MessagingObject } from '~/internal/scoped.ts';
import type { ChannelContext, ScopeHandleObject } from '~/primitives/channels/messaging.ts';
import type {
  ChannelsOptions,
  ChannelsPrimitive,
  SubscribeSource,
} from '~/primitives/channels/types.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

const PERSISTENT_REJOIN_FALLBACK_MS = 5000;

/** Parse a `{ connectionId, meta? }` payload from an untrusted wire message — returns null if the shape is wrong. */
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
 * Server-managed rooms. A channel must be subscribed before you can send or
 * receive on it; the server tracks membership and limits broadcasts to
 * subscribers only. This primitive owns all per-channel state —
 * subscriptions, members, presence — and routes incoming channel messages.
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
        const key = channelKey(scopeKey, name);
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
          const key = channelKey(scopeKey, name);
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
              // A stale server auto-rejoin confirmation for a channel the user
              // intentionally left during the reconnect — drop it so we don't
              // re-activate a channel the server has already removed us from.
              if (source === 'server' && state.ignoreServerRejoin) {
                helpers.log.info(
                  `channel '${name}' ignoring stale server re-subscribe after leave`,
                );
                return null;
              }
              helpers.log.info(`channel '${name}' subscribed (${source})`);
              state.persistent = wskit?.channelPersistent === true;
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
              if (helpers.config.debug)
                helpers.log.info(`routing '${message.event}' to channel '${name}'`);
              state.dispatch(message.event, message.payload);
              notifyFamily((family) => family.dispatch(message.event, message.payload, name));
              return message;
            }
          }
        },
        onOpen() {
          // Flush an unsubscribe held while the socket was connecting BEFORE any
          // subscribe flush — a queued leave wins over a rejoin. Once it's on the
          // wire the local membership clears and onUnsubscribed fires.
          for (const state of states.values()) {
            const leaveFrame = state.pendingUnsubscribeFrame;
            if (!leaveFrame) continue;
            state.pendingUnsubscribeFrame = null;
            helpers.rawSend(leaveFrame);
            state.markUnsubscribed();
            // The server may already have queued an auto-rejoin __subscribeOk__
            // before it saw this leave; ignore that stale confirmation.
            state.ignoreServerRejoin = true;
            if (state.scopeKey) familyFor(state.scopeKey).fireUnsubscribed(state.name);
          }

          // Flush subscribe frames held while the socket was connecting. Each goes
          // with an owner so a frame that can't serialize rejects that exact pending
          // subscribe() (and releases its hold) instead of only being logged.
          for (const state of states.values()) {
            const frame = state.pendingSubscribeFrame;
            if (!frame) continue;
            state.pendingSubscribeFrame = null;
            const sub = state;
            helpers.rawSend(frame, {
              isPending: () => sub.hasPendingSubscribe,
              reject: (error) => sub.failPendingSubscribe(error),
            });
          }
          return null;
        },
        onBeforeReopen() {
          // Re-run function payloads (e.g. a token factory) before reconnecting, so
          // the re-subscribe sends a fresh value instead of the one from the original
          // subscribe call. Plain value payloads don't need refreshing, so when no
          // channel uses a function this returns nothing and reconnect stays synchronous.
          const dynamic = [...states.values()].filter(
            (state) =>
              state.active && !state.persistent && typeof state.subscribeData === 'function',
          );
          if (dynamic.length === 0) return;
          return (async () => {
            for (const state of dynamic) {
              try {
                state.resolvedSubscribeData = await (state.subscribeData as () => unknown)();
              } catch (error) {
                helpers.log.error(
                  `channel '${state.name}' subscribe payload refresh threw; re-subscribing with the last value`,
                  error,
                );
                helpers.log.report(error);
              }
            }
          })();
        },
        onReconnect() {
          // Re-join every channel we were subscribed to before the disconnect. The
          // server confirms with __subscribeOk__ (and a fresh __memberSync__ fills
          // the member list back in). Persistent channels are skipped — the server
          // re-adds those automatically and sends its own __subscribeOk__, so sending
          // a client subscribe on top would run the subscribe flow twice.
          const resubscribes: WireMessage[] = [];
          for (const state of states.values()) {
            if (!state.active) continue;
            // A queued unsubscribe wins: the user asked to leave, so don't rejoin —
            // onOpen flushes the unsubscribe and clears the membership instead.
            if (state.pendingUnsubscribeFrame) continue;
            // Mark the channel as waiting for its subscribe confirmation after
            // reconnect. Persistent channels wait for the server's auto-rejoin;
            // others wait for the client's re-subscribe reply. A failure clears this.
            state.rejoining = true;
            if (!state.persistent) {
              resubscribes.push({
                event: '__subscribe__',
                payload: state.resolvedSubscribeData ?? {},
                __wskit: channelMarkers(state),
              });
            } else {
              const rejoining = state;
              rejoining.clearRejoinTimer();
              rejoining.rejoinTimer = setTimeout(() => {
                rejoining.rejoinTimer = null;
                if (!rejoining.active || !rejoining.rejoining) return;
                helpers.rawSend({
                  event: '__subscribe__',
                  payload: rejoining.resolvedSubscribeData ?? {},
                  __wskit: channelMarkers(rejoining),
                });
              }, PERSISTENT_REJOIN_FALLBACK_MS);
            }
          }
          return resubscribes.length ? resubscribes : null;
        },
        onClose(_code, _reason, intentional) {
          for (const state of states.values()) {
            state.clearRejoinTimer();
            if (state.pending) {
              state.pending.reject(Disconnected());
              state.pending = null;
              state.pendingPromise = null;
              state.pendingSubscribeFrame = null;
              // A channel that never became active won't be re-subscribed on
              // reconnect, so release its idle-prevention hold here or it leaks.
              if (!state.active) state.releaseLazy();
            }

            if (intentional) {
              if (state.active) state.markUnsubscribed();
              continue;
            }

            state.clearMembersForReconnect();
          }
        },
        onReconnectFailed() {
          // Reconnection is abandoned — active channels won't be revived by a
          // reconnect, so release the idle-prevention holds they kept across the
          // drop (else the lazy count leaks) and give them a terminal signal.
          for (const state of states.values()) {
            state.clearRejoinTimer();
            if (state.active) state.markUnsubscribed();
            else state.releaseLazy();
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
channels.tag = 'channels';
