/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin args/api stay generic across call sites */
import { Block, WSKitConfigError } from '@wskit/core';
import type { WireMessage } from '~/internal/runtime.ts';
import type { PluginDef, PluginFactory, PluginHooks, PrimitiveFactory } from '~/plugins/types.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

/**
 * Resolve a primitive factory to its tag for dependency assertion. Prefers a
 * static `tag` if the factory exposes one; otherwise reads the real `_tag` off a
 * throwaway instance. Throws a clear error rather than silently guessing from
 * the function name, so a bad dependency surfaces at definition time.
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
 * Author a reusable client feature. Unlike built-in primitives, a plugin can't
 * add methods to the socket — its API is reached through `Plugin.use(socket)`,
 * which keeps type inference fast. It can still hook the message pipeline and
 * lifecycle. The client `plugin` mirrors the server's, minus server-only pieces
 * (scheduling, migrations).
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
        // One slot per hook — registering the same one twice throws rather than
        // silently shadowing, so a plugin keeps all its behavior in one callback.
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

          install: (socket) => socket._registerPlugin(def.key, registrationId, build),

          onIncoming: incoming
            ? (message) => {
                try {
                  const result = incoming!(message);
                  return result ?? message;
                } catch (error) {
                  if (error !== Block) {
                    helpers.log.error(`plugin '${def.id}' onIncoming threw`, error);
                  }
                  return null;
                }
              }
            : undefined,

          onOutgoing: outgoing
            ? (message) => {
                try {
                  const result = outgoing!(message);
                  return result ?? message;
                } catch (error) {
                  if (error !== Block) {
                    helpers.log.error(`plugin '${def.id}' onOutgoing threw`, error);
                  }
                  return null;
                }
              }
            : undefined,

          onOpen: open
            ? () => {
                try {
                  return open!() ?? null;
                } catch (error) {
                  helpers.log.error(`plugin '${def.id}' onOpen threw`, error);
                  return null;
                }
              }
            : undefined,

          onReconnect: reconnect
            ? () => {
                try {
                  return reconnect!() ?? null;
                } catch (error) {
                  helpers.log.error(`plugin '${def.id}' onReconnect threw`, error);
                  return null;
                }
              }
            : undefined,

          onClose: close
            ? (code, reason) => {
                try {
                  close!(code, reason);
                } catch (error) {
                  helpers.log.error(`plugin '${def.id}' onClose threw`, error);
                }
              }
            : undefined,
        };
      },
    };
  }) as PluginFactory<TArgs, TApi>;

  factory.use = (socket: object, registrationId?: string): TApi =>
    (socket as WSKitSocket)._usePlugin(def.key, registrationId) as TApi;

  return factory;
}
