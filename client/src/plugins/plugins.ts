/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin args/api stay generic across call sites */
import { Block, WSKitConfigError } from '@wskit/core';
import type { WireMessage } from '~/internal/runtime.ts';
import type { PluginDef, PluginFactory, PluginHooks, PrimitiveFactory } from '~/plugins/types.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

/**
 * Get the tag string from a primitive factory so we can check dependencies.
 * Reads the static `tag` property if present; otherwise creates a throwaway
 * instance and reads `_tag` from it. Throws a clear error if neither works,
 * so a bad dependency is caught when the plugin is defined, not at runtime.
 */
function resolveTag(factory: PrimitiveFactory): string {
  if (typeof factory.tag === 'string') return factory.tag;
  try {
    return factory()._tag;
  } catch {
    throw new WSKitConfigError(
      `[wskit] could not resolve a plugin dependency to a primitive tag. Dependencies must be primitive factories (e.g. [ack, channels]).`,
    );
  }
}

/**
 * Plugin APIs per socket, built on first `use()`. Keyed by the plugin's `key`,
 * then by `registrationId` (`undefined` for a one-instance plugin), so a
 * repeatable plugin keeps each instance separate. Held in a module-scoped
 * WeakMap rather than on the socket so the core socket carries no plugin code —
 * it's only here when `plugin()` is in the bundle. Keyed weakly by socket, so a
 * dropped socket takes its plugin entries with it.
 */
type PluginEntry = { build: (socket: WSKitSocket) => unknown; api?: unknown };
const pluginRegistries = new WeakMap<object, Map<symbol, Map<string | undefined, PluginEntry>>>();

function registerPlugin(
  socket: WSKitSocket,
  entry: {
    key: symbol;
    registrationId: string | undefined;
    build: (socket: WSKitSocket) => unknown;
  },
): void {
  let byKey = pluginRegistries.get(socket);
  if (!byKey) {
    byKey = new Map();
    pluginRegistries.set(socket, byKey);
  }
  let byRegistration = byKey.get(entry.key);
  if (!byRegistration) {
    byRegistration = new Map();
    byKey.set(entry.key, byRegistration);
  }
  byRegistration.set(entry.registrationId, { build: entry.build });
}

function usePlugin(socket: object, key: symbol, registrationId: string | undefined): unknown {
  const entry = pluginRegistries.get(socket)?.get(key)?.get(registrationId);
  if (!entry) {
    throw new WSKitConfigError(
      registrationId === undefined
        ? '[wskit] this plugin is not registered on this socket. Pass it to client().'
        : `[wskit] no plugin instance with registrationId '${registrationId}' is registered on this socket.`,
    );
  }
  if (!('api' in entry)) {
    try {
      entry.api = entry.build(socket as WSKitSocket);
    } finally {
      if (!('api' in entry)) entry.api = undefined;
    }
  }
  return entry.api;
}

/**
 * Define a reusable client feature. Unlike built-in primitives, a plugin can't
 * add methods directly to the socket — its API is accessed via `Plugin.use(socket)`,
 * which keeps TypeScript inference fast. It can still hook into the message pipeline
 * and lifecycle events. The client `plugin` mirrors the server's, minus server-only
 * features (scheduling, migrations).
 *
 * ```ts
 * const KEY = Symbol('acme:metrics');
 *
 * const Metrics = plugin<{ sampleRate?: number }>({
 *   id: 'acme:metrics',
 *   key: KEY,
 *   setup(args, hooks) {
 *     const counts = new Map<string, number>();
 *     hooks.onIncoming((message) => {
 *       counts.set(message.event, (counts.get(message.event) ?? 0) + 1);
 *       return message;
 *     });
 *     return () => ({ count: (event: string) => counts.get(event) ?? 0 });
 *   },
 * });
 *
 * const socket = client<MySocket>()(
 *    connect('wss://...'),
 *    Metrics({ sampleRate: 0.5 })
 * );
 *
 * const metrics = Metrics.use(socket);
 * ```
 *
 * Add `registrationId` to make a plugin repeatable — register it more than once
 * and pick an instance with `.use(socket, registrationId)`:
 *
 * ```ts
 * const ANALYTICS = Symbol('acme:analytics');
 *
 * const Analytics = plugin<{ tracker: string }>({
 *   id: 'acme:analytics',
 *   key: ANALYTICS,
 *   registrationId: (args) => args.tracker,   // one instance per tracker
 *   setup(args) {
 *     return () => ({ tracker: args.tracker });
 *   },
 * });
 *
 * const socket = client<MySocket>()(
 *    connect('wss://...'),
 *    Analytics({ tracker: 'ga' }),
 *    Analytics({ tracker: 'mixpanel' }),
 * );
 *
 * Analytics.use(socket, 'ga').tracker;        // → 'ga'
 * Analytics.use(socket, 'mixpanel').tracker;  // → 'mixpanel'
 * ```
 */
export function plugin<TArgs = void, TApi = unknown>(
  def: PluginDef<TArgs, TApi>,
): PluginFactory<TArgs, TApi> {
  const dependencies = def.dependencies?.map(resolveTag);

  const factory = ((args: TArgs): Primitive<EmptyTypeFn> => {
    const registrationId = def.registrationId?.(args);

    return {
      _tag: def.id,
      _plugin: { key: def.key, id: def.id, registrationId },
      dependencies,
      setup(helpers) {
        // Each hook can only be registered once — doing it twice throws instead of
        // quietly replacing the first one, so all the plugin's logic stays in one callback.
        let incoming: ((message: WireMessage) => WireMessage | void) | null = null;
        let outgoing: ((message: WireMessage) => WireMessage | void) | null = null;
        let open: (() => WireMessage[] | void) | null = null;
        let reconnect: (() => WireMessage[] | void) | null = null;
        let close: ((code: number, reason: string) => void) | null = null;

        function once<T>(name: string, current: T | null, handler: T): T {
          if (current) {
            throw new WSKitConfigError(
              `[wskit] plugin '${def.id}' registered ${name}() twice — use a single callback.`,
            );
          }
          return handler;
        }

        const hooks: PluginHooks = {
          onIncoming: (handler) => void (incoming = once('onIncoming', incoming, handler)),
          onOutgoing: (handler) => void (outgoing = once('onOutgoing', outgoing, handler)),
          onOpen: (handler) => void (open = once('onOpen', open, handler)),
          onReconnect: (handler) => void (reconnect = once('onReconnect', reconnect, handler)),
          onClose: (handler) => void (close = once('onClose', close, handler)),
          generateId: (prefix) => helpers.generateId(prefix),
          getState: () => helpers.getState(),
        };

        const build = def.setup(args, hooks);

        return {
          id: registrationId ? `${def.id}#${registrationId}` : def.id,

          install: (socket) => registerPlugin(socket, { key: def.key, registrationId, build }),

          onIncoming: (message) => {
            if (!incoming) return message;
            try {
              const result = incoming(message);
              return result ?? message;
            } catch (error) {
              if (error !== Block) {
                helpers.log.error(`plugin '${def.id}' onIncoming threw`, error);
              }
              return null;
            }
          },

          onOutgoing: (message) => {
            if (!outgoing) return message;
            try {
              const result = outgoing(message);
              return result ?? message;
            } catch (error) {
              if (error !== Block) {
                helpers.log.error(`plugin '${def.id}' onOutgoing threw`, error);
              }
              return null;
            }
          },

          onOpen: () => {
            if (!open) return null;
            try {
              return open() ?? null;
            } catch (error) {
              helpers.log.error(`plugin '${def.id}' onOpen threw`, error);
              return null;
            }
          },

          onReconnect: () => {
            if (!reconnect) return null;
            try {
              return reconnect() ?? null;
            } catch (error) {
              helpers.log.error(`plugin '${def.id}' onReconnect threw`, error);
              return null;
            }
          },

          onClose: (code, reason) => {
            if (!close) return;
            try {
              close(code, reason);
            } catch (error) {
              helpers.log.error(`plugin '${def.id}' onClose threw`, error);
            }
          },
        };
      },
    };
  }) as PluginFactory<TArgs, TApi>;

  factory.use = (socket: object, registrationId?: string): TApi =>
    usePlugin(socket, def.key, registrationId) as TApi;

  return factory;
}
