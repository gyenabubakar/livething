import { Disconnected } from '~/errors.ts';
import { channelKey } from '~/internal/channel-key.ts';
import { toLiveThingError, unscopeErrorCode } from '~/internal/error-frame.ts';
import { getAugmenters, scopedName } from '~/internal/scoped.ts';
import { isProtocolFrameEvent } from '~/internal/wire-validation.ts';
import { markRejoinConfirmation } from '~/primitives/channels/leave-confirmation.ts';
import {
  buildChannelMessaging,
  buildFamilyHandle,
  channelMarkers,
} from '~/primitives/channels/messaging.ts';
import { ChannelState, FamilyState } from '~/primitives/channels/state.ts';
import type { LiveThingError } from '@livething/core';
import type { LiveThingMetadata, Message } from '~/internal/runtime.ts';
import type { MessagingObject, ScopeInfo } from '~/internal/scoped.ts';
import type { ChannelContext, FamilyHandle } from '~/primitives/channels/messaging.ts';
import type { ChannelsPrimitive, SubscribeSource } from '~/primitives/channels/types.ts';
import type { LiveThingSocket } from '~/socket/socket.ts';

const PERSISTENT_REJOIN_FALLBACK_MS = 5000;

/**
 * Strip a plugin-owned channel's namespace off an incoming event. A plugin
 * channel travels as `__<id>::<room>` and its emits as `__<id>::<event>`, but
 * the client contract registers each handler under the bare `<event>` — so an
 * event sharing the channel's `__<id>::` prefix is delivered under its short
 * name. A non-plugin channel (whose prefix is `''`) and any event that doesn't
 * carry the prefix pass through untouched.
 */
function channelEventName(prefix: string, event: string): string {
  return prefix && event.startsWith(prefix) ? event.slice(prefix.length) : event;
}

/** Parse a `{ memberId, meta? }` payload from an untrusted wire message — returns null if the shape is wrong. */
function readMember(payload: unknown): { memberId: string; meta?: Record<string, unknown> } | null {
  const fields = (payload ?? {}) as { memberId?: unknown; meta?: unknown };
  if (typeof fields.memberId !== 'string') return null;

  return {
    memberId: fields.memberId,
    meta: fields.meta as Record<string, unknown> | undefined,
  };
}

/** Parse one `{ memberId, meta?, online }` roster entry of a `__memberSync__` — null if the shape is wrong. */
function readSyncMember(
  entry: unknown,
): { memberId: string; meta?: Record<string, unknown>; online: boolean } | null {
  const member = readMember(entry);
  const online = (entry as { online?: unknown } | null | undefined)?.online;
  if (!member || typeof online !== 'boolean') return null;

  return { ...member, online };
}

/**
 * True when an `__error__` payload names the frame it answers, and that frame
 * is not a subscribe: a channel message or another protocol frame such as
 * `__replay__`.
 */
function answersAnotherEvent(payload: unknown): boolean {
  const detail = (payload as { detail?: { event?: unknown } } | null | undefined)?.detail;
  return typeof detail?.event === 'string' && detail.event !== '__subscribe__';
}

/** The host `channel` method: a fixed/dynamic getter plus `.family`. */
type HostChannel = {
  (nameOrFamily: string, name?: string): MessagingObject;
  family(familyKey: string): FamilyHandle;
};

interface ChannelIncoming {
  message: Message;
  state: ChannelState;
  name: string;
  familyKey: string | undefined;
  metadata: LiveThingMetadata | null | undefined;
}

const PRESENCE_EVENTS = new Set([
  '__memberSync__',
  '__memberJoin__',
  '__memberLeave__',
  '__memberOnline__',
  '__memberOffline__',
]);

/**
 * Wrap the host `channel` method for a plugin scope. A plugin owns its namespace,
 * so the static channel name and the dynamic family KEY are prefixed with
 * `__<id>::` on the way to the wire. A family's concrete member name is a runtime
 * value the server matches against the (un-prefixed) family pattern, so it is left
 * as the plugin wrote it — which also means the family handle already surfaces
 * plain member names, with nothing to strip.
 */
function scopedChannelMethod(channel: HostChannel, scope: ScopeInfo): HostChannel {
  function scoped(nameOrFamily: string, name?: string): MessagingObject {
    return name === undefined
      ? channel(scopedName(scope, nameOrFamily))
      : channel(scopedName(scope, nameOrFamily), name);
  }

  scoped.family = (familyKey: string): FamilyHandle => channel.family(scopedName(scope, familyKey));
  return scoped;
}

/**
 * Server-managed rooms. A channel must be subscribed before you can send or
 * receive on it; the server tracks membership and limits broadcasts to
 * subscribers only. This primitive owns all per-channel state —
 * subscriptions, members, presence — and routes incoming channel messages.
 */
export function channels(): ChannelsPrimitive {
  return {
    _tag: 'channels',
    setup(helpers) {
      const states = new Map<string, ChannelState>();
      const cache = new Map<string, MessagingObject>();
      const families = new Map<string, FamilyState>();
      const familyHandles = new Map<string, FamilyHandle>();
      const warnedInboxMissing = new Set<string>();

      const warnedReadReceiptsMissing = new Set<string>();
      let socket: LiveThingSocket; // assigned in install, before any handle is built

      function warnMissingReceiptPrimitive(
        key: string,
        name: string,
        metadata?: LiveThingMetadata | null,
      ): void {
        if (
          metadata?.channel?.inbox === true &&
          !helpers.hasPrimitive('inbox') &&
          !warnedInboxMissing.has(key)
        ) {
          warnedInboxMissing.add(key);
          helpers.log.warn(
            `channel '${name}' is inbox-backed but inbox() is not registered — received receipts will not be tracked. Add inbox() to client().`,
          );
        }

        if (
          metadata?.channel?.readReceipts === true &&
          !helpers.hasPrimitive('read-receipts') &&
          !warnedReadReceiptsMissing.has(key)
        ) {
          warnedReadReceiptsMissing.add(key);
          helpers.log.warn(
            `channel '${name}' has read receipts enabled but readReceipts() is not registered — read receipts will not be tracked. Add readReceipts() to client().`,
          );
        }
      }

      function stateFor(name: string, familyKey?: string): ChannelState {
        const key = channelKey(familyKey, name);
        let state = states.get(key);
        if (!state) {
          state = new ChannelState(name, familyKey, helpers.log);
          states.set(key, state);
        }

        return state;
      }

      function familyFor(familyKey: string): FamilyState {
        let family = families.get(familyKey);
        if (!family) {
          family = new FamilyState(helpers.log);
          families.set(familyKey, family);
        }

        return family;
      }

      function listFamily(familyKey: string): string[] {
        const names: string[] = [];
        for (const state of states.values()) {
          if (state.familyKey === familyKey && state.active) names.push(state.name);
        }

        return names;
      }

      const context: ChannelContext = {
        helpers,
        family: familyFor,
        listFamily,
        get socket() {
          return socket;
        },
        messagingFor(name, familyKey) {
          const key = channelKey(familyKey, name);
          let messaging = cache.get(key);
          if (!messaging) {
            messaging = buildChannelMessaging(context, stateFor(name, familyKey));
            cache.set(key, messaging);
          }

          return messaging;
        },
      };

      function handleSubscribe(incoming: ChannelIncoming): Message | null {
        const { message, state, name, familyKey, metadata } = incoming;
        const source: SubscribeSource =
          metadata?.exchange?.source === 'server' ? 'server' : 'client';
        if (state.pendingLeave !== null) {
          helpers.log.info(
            `channel '${name}' ignoring a subscribe confirmation while a leave is pending`,
          );
          return null;
        }

        helpers.log.info(`channel '${name}' subscribed (${source})`);
        warnMissingReceiptPrimitive(channelKey(familyKey, name), name, metadata);

        state.persistent = metadata?.channel?.membership === 'persistent';
        state.markSubscribed(source);
        if (familyKey) familyFor(familyKey).fireSubscribed(name, source);

        return message;
      }

      function handlePresence(message: Message, state: ChannelState, name: string): null {
        if (!state.active || state.pendingLeave !== null) {
          helpers.log.info(`channel '${name}' ignoring a presence frame for an inactive channel`);
          return null;
        }

        if (message.event === '__memberSync__') {
          const raw = (message.payload as { members?: unknown })?.members;
          state.syncMembers(
            Array.isArray(raw) ? raw.map(readSyncMember).filter((m) => m !== null) : [],
          );
          return null;
        }

        const member = readMember(message.payload);
        if (!member) return null;

        switch (message.event) {
          case '__memberJoin__':
            state.addMember(member.memberId, member.meta);
            break;

          case '__memberLeave__':
            state.removeMember(member.memberId);
            break;

          case '__memberOnline__':
            state.memberWentOnline(member.memberId, member.meta);
            break;

          case '__memberOffline__':
            state.memberWentOffline(member.memberId);
            break;
        }

        return null;
      }

      /**
       * Claim a channel `__error__` only when it answers a subscribe or a
       * reconnect rejoin. Any other channel error (a failed send, a `__replay__`
       * the server does not support) goes on to later primitives and
       * `onServerError`.
       */
      function handleChannelError(incoming: ChannelIncoming): Message | null {
        const { message, state, name, familyKey, metadata } = incoming;
        if (metadata?.exchange?.id !== undefined || metadata?.stream !== undefined) return message;

        if (!state.hasSubscribeInFlight || answersAnotherEvent(message.payload)) return message;

        const error = unscopeErrorCode(
          familyKey ?? name,
          toLiveThingError(message.payload),
        ) as LiveThingError;
        state.fireSubscriptionFailed(error);

        return null;
      }

      function handleChannelEvent(incoming: ChannelIncoming): Message {
        const { message, state, name, familyKey, metadata } = incoming;
        if (
          isProtocolFrameEvent(message.event) ||
          metadata?.exchange?.id !== undefined ||
          metadata?.stream !== undefined
        ) {
          return message;
        }

        const event = channelEventName(state.eventPrefix, message.event);
        if (helpers.log.debug) helpers.log.info(`routing '${event}' to channel '${name}'`);
        state.dispatch(event, message.payload);

        if (familyKey) familyFor(familyKey).dispatch(event, message.payload, name);

        return message;
      }

      function handleIncoming(message: Message): Message | null {
        const metadata = message.metadata;
        const name = metadata?.channel?.name;
        if (typeof name !== 'string') return message;

        const familyKey = metadata?.channel?.family;
        const state = stateFor(name, familyKey);
        const incoming = { message, state, name, familyKey, metadata };
        if (PRESENCE_EVENTS.has(message.event)) return handlePresence(message, state, name);

        switch (message.event) {
          case '__subscribeOk__':
            return handleSubscribe(incoming);

          case '__unsubscribeOk__': {
            const id = metadata?.channel?.unsubscribeId;
            if (typeof id !== 'string') return null;

            const confirmation = state.confirmLeave(id);
            if (!confirmation) return null;

            return confirmation.rejoinPending ? markRejoinConfirmation(message) : message;
          }

          case '__kicked__': {
            const reason = (message.payload as { reason?: unknown })?.reason;
            state.fireKicked(typeof reason === 'string' ? reason : '');
            state.markUnsubscribed();
            if (familyKey) familyFor(familyKey).fireUnsubscribed(name);
            return message;
          }

          case '__error__':
            return handleChannelError(incoming);

          default:
            return handleChannelEvent(incoming);
        }
      }

      return {
        id: 'channels',
        onIncoming: handleIncoming,

        onOpen() {
          // Resend any outstanding leave BEFORE the subscribe flush — a leave wins
          // over a rejoin. A leave that didn't reach the server before a drop is
          // resent here (same id) until its __unsubscribeOk__ confirms it. While a
          // leave is pending the channel is already inactive, so onReconnect skips
          // its rejoin and a server auto-rejoin __subscribeOk__ is ignored.
          for (const state of states.values()) {
            if (!state.pendingLeave) continue;

            helpers.rawSend({
              event: '__unsubscribe__',
              payload: null,
              metadata: {
                channel: {
                  ...channelMarkers(state),
                  unsubscribeId: state.pendingLeave.unsubscribeId,
                },
              },
            });
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
          const resubscribes: Message[] = [];
          for (const state of states.values()) {
            // A leaving channel is already inactive, so this skip also keeps a
            // pending leave from rejoining — onOpen resends the leave instead.
            if (!state.active) continue;

            // Mark the channel as waiting for its subscribe confirmation after
            // reconnect. Persistent channels wait for the server's auto-rejoin;
            // others wait for the client's re-subscribe reply. A failure clears this.
            state.rejoining = true;
            state.markSubscribing();
            if (!state.persistent) {
              resubscribes.push({
                event: '__subscribe__',
                payload: state.resolvedSubscribeData ?? {},
                metadata: { channel: channelMarkers(state) },
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
                  metadata: { channel: channelMarkers(rejoining) },
                });
              }, PERSISTENT_REJOIN_FALLBACK_MS);
            }
          }

          return resubscribes.length ? resubscribes : null;
        },

        onClose(_code, _reason, intentional) {
          for (const state of states.values()) {
            state.clearRejoinTimer();

            // A subscribe queued behind a reliable leave must survive a retryable
            // drop: the leave is resent on reopen and the queued subscribe runs
            // (with a freshly-resolved payload) once it confirms. Only an intentional
            // close or a permanent failure (failLeave, below) clears it.
            const queuedBehindLeave =
              state.deferredSubscribe !== null && state.pendingLeave !== null;

            if (state.pending && !(queuedBehindLeave && !intentional)) {
              state.pending.reject(Disconnected());
              state.pending = null;
              state.pendingPromise = null;
              state.pendingSubscribeFrame = null;
              state.deferredSubscribe = null;

              // A channel that never became active won't be re-subscribed on
              // reconnect, so release its idle-prevention hold here or it leaks.
              if (!state.active) state.releaseLazy();
            }

            if (intentional) {
              // An intentional disconnect ends everything — a leave will never be
              // confirmed, so reject it (and any queued re-subscribe) instead of
              // leaving its promise hanging.
              if (state.pendingLeave) state.failLeave(Disconnected());
              else if (state.active) state.markUnsubscribed();
              continue;
            }

            // A transient drop keeps any pending leave (and the subscribe queued
            // behind it): onOpen resends the leave on reopen.
            state.clearMembersForReconnect();
          }
        },

        onReconnectFailed() {
          // Reconnection is abandoned. Active channels won't be revived, so release
          // their idle-prevention holds and give them a terminal signal; an
          // outstanding leave can never be confirmed now, so reject it.
          for (const state of states.values()) {
            state.clearRejoinTimer();

            if (state.pendingLeave) state.failLeave(Disconnected());
            else if (state.active) state.markUnsubscribed();
            else state.releaseLazy();
          }
        },

        install(installedSocket) {
          socket = installedSocket;

          function channel(nameOrFamily: string, name?: string): MessagingObject {
            return name === undefined
              ? context.messagingFor(nameOrFamily)
              : context.messagingFor(name, nameOrFamily);
          }

          channel.family = (familyKey: string): FamilyHandle => {
            let handle = familyHandles.get(familyKey);
            if (!handle) {
              handle = buildFamilyHandle(context, familyKey);
              familyHandles.set(familyKey, handle);
            }

            return handle;
          };

          // @ts-expect-error — install adds channel() to the socket dynamically
          installedSocket.channel = channel;

          // A plugin scope prefixes names, so it can own channels — reach them
          // under the plugin's namespace. A channel scope has no `prefixName` and
          // channels don't nest, so it gets no `channel` here.
          getAugmenters(installedSocket).push((messaging, scope) => {
            if (!scope.prefixName) return;

            messaging.channel = scopedChannelMethod(channel, scope);
          });
        },
      };
    },
  };
}

channels.tag = 'channels' as const;
