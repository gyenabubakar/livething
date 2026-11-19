import { LiveThingConfigError, utf8ByteLength } from '@livething/core';
import { channelKey } from '~/internal/channel-key.ts';
import { CHANNEL_VIEW_KEY } from '~/internal/runtime.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import { createStore } from '~/internal/store.ts';
import type { ChannelView, ChannelViewOf, Message } from '~/internal/runtime.ts';
import type { WritableStore } from '~/internal/store.ts';
import type {
  AwarenessEntry,
  AwarenessOptions,
  AwarenessPrimitive,
  AwarenessRefusal,
  ChannelAwarenessApi,
} from '~/primitives/awareness/types.ts';
import type { ChannelStatus } from '~/primitives/channels/types.ts';

type Entry = AwarenessEntry<unknown>;
type State = Record<string, unknown>;

const DEFAULT_THROTTLE_MS = 50;
const MAX_TIMER_MS = 2_147_483_647;
/** How many earlier connection IDs of this socket are kept, to drop their ghost entries. */
const GHOST_IDS = 8;
const REASONS: ReadonlySet<unknown> = new Set(['too-large', 'invalid', 'check', 'error']);

/** One channel's awareness state on this client. */
interface ChannelAwareness {
  name: string;
  family: string | undefined;
  view: ChannelView;
  /** Tells a rejoin from a first subscribe: both are `subscribing`. */
  joined: boolean;
  /** The server said it has no awareness here; a `__subscribeOk__` with it ends this. */
  stopped: boolean;
  mineJson: string | null;
  mine: WritableStore<State | null>;
  self: WritableStore<Entry | null>;
  others: WritableStore<ReadonlyMap<string, Entry>>;
  synced: WritableStore<boolean>;
  /** The sync being received, piece by piece, or `null`. */
  syncBuffer: Map<string, Entry> | null;
  /** The JSON of `mine` last sent in this subscribed period. */
  lastSentJson: string | null;
  /** A `set()` that waits for the throttle. */
  waiting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  refusedListeners: Set<(refusal: AwarenessRefusal) => void>;
  api: ChannelAwarenessApi<unknown> | null;
}

/**
 * Live state for each connection in a channel: a cursor, the message someone is reading,
 * a selection. Adds `channel.awareness` to channels whose server config has `awareness`.
 */
export function awareness(options: AwarenessOptions = {}): AwarenessPrimitive {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  if (!Number.isInteger(throttleMs) || throttleMs < 0 || throttleMs > MAX_TIMER_MS) {
    throw new LiveThingConfigError(
      `awareness throttleMs must be a whole number from 0 to ${MAX_TIMER_MS}, got ${throttleMs}.`,
    );
  }

  return {
    _tag: 'awareness',
    dependencies: ['channels'],
    setup(helpers) {
      const channels = new Map<string, ChannelAwareness>();
      const ghosts: string[] = [];
      let ownId: string | null = null;

      function stateFor(name: string, family: string | undefined): ChannelAwareness {
        const key = channelKey(family, name);
        const existing = channels.get(key);
        if (existing) return existing;

        const view = (helpers.shared.get(CHANNEL_VIEW_KEY) as ChannelViewOf)(name, family);
        function report(error: unknown) {
          helpers.log.report(error);
        }

        const channel: ChannelAwareness = {
          name,
          family,
          view,
          // channels() runs first, so a `__subscribeOk__` has already changed the status.
          joined: view.active() || view.status.get() === 'subscribed',
          stopped: false,
          mineJson: null,
          mine: createStore<State | null>(null, report),
          self: createStore<Entry | null>(null, report),
          others: createStore<ReadonlyMap<string, Entry>>(new Map(), report),
          synced: createStore(false, report),
          syncBuffer: null,
          lastSentJson: null,
          waiting: false,
          timer: null,
          refusedListeners: new Set(),
          api: null,
        };

        channels.set(key, channel);
        view.status.subscribe((next) => onStatus(channel, next));

        return channel;
      }

      function status(channel: ChannelAwareness): ChannelStatus {
        return channel.view.status.get();
      }

      /** The server has no awareness on this channel (a redeploy removed it). */
      function off(channel: ChannelAwareness): boolean {
        return (
          channel.stopped ||
          (status(channel) === 'subscribed' && channel.view.awareness() === undefined)
        );
      }

      function accepts(channel: ChannelAwareness): boolean {
        const current = status(channel);
        const joined = current === 'subscribed' || (current === 'subscribing' && channel.joined);
        if (joined && !off(channel)) return true;

        helpers.log.info(`channel '${channel.name}' awareness ignored: the channel is not joined`);

        return false;
      }

      function refuse(channel: ChannelAwareness, reason: AwarenessRefusal['reason']): void {
        helpers.log.info(`channel '${channel.name}' awareness update refused: ${reason}`);
        for (const listener of [...channel.refusedListeners]) {
          try {
            listener({ reason });
          } catch (error) {
            helpers.log.report(error);
          }
        }
      }

      function tooLarge(channel: ChannelAwareness, json: string): boolean {
        const maxBytes = channel.view.awareness()?.maxBytes;
        return maxBytes !== undefined && utf8ByteLength(json) > maxBytes;
      }

      function rawSend(channel: ChannelAwareness, state: State | null): boolean {
        if (status(channel) !== 'subscribed') return false;

        try {
          const result = helpers.rawSend({
            event: '__awarenessSet__',
            payload: { state },
            metadata: {
              channel: {
                name: channel.name,
                ...(channel.family ? { family: channel.family } : {}),
              },
            },
          });
          return result === 'sent';
        } catch (error) {
          helpers.log.report(error);
          return false;
        }
      }

      function sendMine(channel: ChannelAwareness): void {
        if (rawSend(channel, channel.mine.store.get())) channel.lastSentJson = channel.mineJson;
      }

      function startWait(channel: ChannelAwareness): void {
        if (throttleMs === 0) return;

        channel.timer = setTimeout(() => {
          channel.timer = null;
          if (!channel.waiting) return;

          channel.waiting = false;
          if (off(channel) || helpers.getState() !== 'open') return;

          if (channel.mineJson === channel.lastSentJson) return;

          sendMine(channel);
          startWait(channel);
        }, throttleMs);
      }

      function stopWait(channel: ChannelAwareness): void {
        if (channel.timer) clearTimeout(channel.timer);
        channel.timer = null;
        channel.waiting = false;
      }

      function set(channel: ChannelAwareness, state: unknown): void {
        if (!accepts(channel)) return;

        let json: unknown;
        try {
          json = JSON.stringify(state);
        } catch {
          refuse(channel, 'invalid');
          return;
        }

        const value: unknown = typeof json === 'string' ? JSON.parse(json) : null;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          refuse(channel, 'invalid');
          return;
        }

        if (tooLarge(channel, json as string)) {
          refuse(channel, 'too-large');
          return;
        }

        channel.mineJson = json as string;
        channel.mine.set(value as State);
        if (channel.timer) {
          channel.waiting = true;
          return;
        }

        if (status(channel) !== 'subscribed') return;

        sendMine(channel);
        startWait(channel);
      }

      function clear(channel: ChannelAwareness): void {
        if (!accepts(channel)) return;

        const nothing =
          channel.mine.store.get() === null &&
          channel.self.store.get() === null &&
          !channel.waiting;
        channel.waiting = false;
        channel.mineJson = null;
        channel.mine.set(null);
        if (nothing) return;

        if (rawSend(channel, null)) channel.lastSentJson = null;
      }

      /** Unsubscribed, kicked, failed, or the server has no awareness here. */
      function leaveReset(channel: ChannelAwareness): void {
        stopWait(channel);
        channel.mineJson = null;
        channel.syncBuffer = null;
        channel.lastSentJson = null;
        channel.mine.set(null);

        channel.self.set(null);
        if (channel.others.store.get().size > 0) channel.others.set(new Map());
        channel.synced.set(false);
      }

      function onStatus(channel: ChannelAwareness, next: ChannelStatus): void {
        if (next !== 'subscribed') {
          channel.syncBuffer = null;
          channel.lastSentJson = null;
        }

        if (next === 'unsubscribed' || next === 'failed') {
          channel.joined = false;
          leaveReset(channel);
          return;
        }

        if (next !== 'subscribed') return;

        channel.joined = true;
        if (channel.view.awareness() !== undefined) channel.stopped = false;
        if (off(channel)) {
          leaveReset(channel);
          return;
        }

        if (channel.mineJson === null || channel.lastSentJson === channel.mineJson) return;

        // A redeploy may have lowered the limit; the server would drop the frame unread.
        if (tooLarge(channel, channel.mineJson)) {
          refuse(channel, 'too-large');
          return;
        }

        stopWait(channel);
        sendMine(channel);
        startWait(channel);
      }

      function readEntry(raw: unknown, updatedAt: number): Entry | null {
        const fields = (raw ?? {}) as Partial<Entry>;
        if (
          typeof fields.connectionId !== 'string' ||
          typeof fields.memberId !== 'string' ||
          !isRecord(fields.meta) ||
          !isRecord(fields.state)
        ) {
          return null;
        }

        return {
          connectionId: fields.connectionId,
          memberId: fields.memberId,
          meta: fields.meta,
          state: fields.state,
          updatedAt,
        };
      }

      function isOwnOrGhost(connectionId: string): boolean {
        return connectionId === ownId || ghosts.includes(connectionId);
      }

      function handleSync(channel: ChannelAwareness, payload: unknown): void {
        if (status(channel) !== 'subscribed') return;

        const { entries, more } = (payload ?? {}) as { entries?: unknown; more?: unknown };
        if (!Array.isArray(entries)) {
          helpers.log.error(`channel '${channel.name}' got an awareness sync it cannot use`);
          return;
        }

        if (channel.syncBuffer === null) {
          channel.syncBuffer = new Map();
          channel.self.set(null);
        }

        const now = Date.now();
        for (const raw of entries) {
          const ageMs = (raw as { ageMs?: unknown } | null)?.ageMs;
          const entry = readEntry(raw, now - (typeof ageMs === 'number' ? Math.max(0, ageMs) : 0));
          if (entry && !isOwnOrGhost(entry.connectionId)) {
            channel.syncBuffer.set(entry.connectionId, entry);
          }
        }

        if (more === true) return;

        // Two empty lists are the same list: do not wake the app for nothing.
        if (channel.syncBuffer.size > 0 || channel.others.store.get().size > 0) {
          channel.others.set(channel.syncBuffer);
        }

        channel.syncBuffer = null;
        channel.synced.set(true);
      }

      function handleChanges(channel: ChannelAwareness, payload: unknown): void {
        if (status(channel) !== 'subscribed') return;

        const list = (payload as { changes?: unknown } | null)?.changes;
        let others: Map<string, Entry> | null = null;
        let self = channel.self.store.get();
        let selfChanged = false;
        const now = Date.now();

        for (const raw of Array.isArray(list) ? list : []) {
          const change = (raw ?? {}) as Partial<Entry>;
          const id = change.connectionId;
          if (typeof id !== 'string' || (id !== ownId && ghosts.includes(id))) continue;

          const known = id === ownId ? self : (others ?? channel.others.store.get()).get(id);
          if (change.state === null) {
            if (!known) continue;

            if (id === ownId) {
              self = null;
              selfChanged = true;
            } else {
              others ??= new Map(channel.others.store.get());
              others.delete(id);
            }

            continue;
          }

          const entry = readEntry({ ...change, meta: change.meta ?? known?.meta }, now);
          if (!entry) {
            helpers.log.error(`channel '${channel.name}' got an awareness change it cannot use`);
            continue;
          }

          if (id === ownId) {
            self = entry;
            selfChanged = true;
          } else {
            others ??= new Map(channel.others.store.get());
            others.set(id, entry);
          }
        }

        if (others) channel.others.set(others);
        if (selfChanged) channel.self.set(self);
      }

      /** `channelOf` makes the state only for an error about awareness. */
      function handleError(channelOf: () => ChannelAwareness, message: Message): Message | null {
        const { code, detail } = (message.payload ?? {}) as {
          code?: unknown;
          detail?: { event?: unknown; reason?: unknown };
        };
        if (detail?.event !== '__awarenessSet__') return message;

        const channel = channelOf();
        if (code === 'awareness-refused') {
          refuse(
            channel,
            REASONS.has(detail.reason) ? (detail.reason as AwarenessRefusal['reason']) : 'error',
          );
          return null;
        }

        if (code === 'unsupported-protocol') {
          helpers.log.warn(`channel '${channel.name}' has no awareness on the server`);
          channel.stopped = true;
          leaveReset(channel);
          return null;
        }

        return message;
      }

      function apiFor(channel: ChannelAwareness): ChannelAwarenessApi<unknown> {
        channel.api ??= {
          set: (state) => set(channel, state),
          clear: () => clear(channel),
          mine: channel.mine.store,
          self: channel.self.store,
          others: channel.others.store,
          synced: channel.synced.store,
          onRefused(callback) {
            channel.refusedListeners.add(callback);
            return () => channel.refusedListeners.delete(callback);
          },
        };

        return channel.api;
      }

      return {
        id: 'awareness',

        onIncoming(message) {
          const name = message.metadata?.channel?.name;
          if (typeof name !== 'string') return message;

          const family = message.metadata?.channel?.family;
          switch (message.event) {
            case '__subscribeOk__':
              // A server-pushed subscribe builds no handle, so make the state here.
              // A confirmation for a channel already subscribed changes no status, so the
              // stop after an `unsupported-protocol` also ends here.
              if (message.metadata?.channel?.awareness !== undefined) {
                stateFor(name, family).stopped = false;
              }

              return message;

            case '__awarenessSync__':
              handleSync(stateFor(name, family), message.payload);
              return null;

            case '__awareness__':
              handleChanges(stateFor(name, family), message.payload);
              return null;

            case '__error__':
              return handleError(() => stateFor(name, family), message);

            default:
              return message;
          }
        },

        onConnected(info) {
          if (ownId !== null && ownId !== info.connectionId) {
            ghosts.push(ownId);
            if (ghosts.length > GHOST_IDS) ghosts.shift();
          }

          ownId = info.connectionId;
        },

        onClose() {
          // The new connection has no state yet. `others` stays until the next sync.
          for (const channel of channels.values()) {
            channel.syncBuffer = null;
            channel.lastSentJson = null;
            channel.self.set(null);
            channel.synced.set(false);
          }
        },

        install(socket) {
          getAugmenters(socket).push((messaging, scope) => {
            const { name, family } = scope.markers();
            if (!name) return;

            Object.defineProperty(messaging, 'awareness', {
              configurable: true,
              enumerable: true,
              get: () => apiFor(stateFor(name, family ?? undefined)),
            });
          });
        },
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

awareness.tag = 'awareness' as const;
