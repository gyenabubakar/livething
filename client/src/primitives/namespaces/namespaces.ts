import { dispatchToHandlers } from '~/internal/dispatch.ts';
import { applyAugmenters } from '~/internal/scoped.ts';
import type { MessagingObject, ScopeMarkers } from '~/internal/scoped.ts';
import type { NamespacesOptions, NamespacesTypeFn } from '~/primitives/namespaces/types.ts';
import type { Primitive } from '~/primitives/types.ts';
import type { ScopeContract } from '~/types.ts';

type Handler = (data: unknown) => void;

/**
 * Splits one connection into named groups of events. A namespace is pure
 * client-side routing — the server doesn't track who's in a namespace and
 * there's nothing to join. Calling `socket.namespace('chat')` gives you an
 * object whose `on`/`send` are scoped to that name, tagged on the wire with
 * `__wskit.namespace`.
 */
export function namespaces(
  options: NamespacesOptions = {},
): Primitive<NamespacesTypeFn, { namespaces: Record<string, ScopeContract> }> {
  return {
    _tag: 'namespaces',
    setup(helpers) {
      // namespace name -> event name -> handlers
      const handlers = new Map<string, Map<string, Set<Handler>>>();
      const cache = new Map<string, MessagingObject>();

      function resolveTtl(event: string): number | undefined {
        if (typeof options.ttl === 'number') return options.ttl;
        if (options.ttl) return options.ttl[event];
        return undefined;
      }

      function register(name: string, event: string, handler: Handler): () => void {
        let byEvent = handlers.get(name);
        if (!byEvent) {
          byEvent = new Map();
          handlers.set(name, byEvent);
        }
        let set = byEvent.get(event);
        if (!set) {
          set = new Set();
          byEvent.set(event, set);
        }
        set.add(handler);
        helpers.lazyAcquire();
        // Guard so calling this unsubscribe more than once releases the lazy hold
        // only once — a second call must not steal another listener's hold.
        let released = false;
        return () => {
          if (released) return;
          released = true;
          set.delete(handler);
          if (set.size === 0) byEvent.delete(event);
          helpers.lazyRelease();
        };
      }

      return {
        id: 'namespaces',
        onIncoming(message) {
          const name = message.__wskit?.namespace;
          if (typeof name !== 'string') return message;
          // Leave request responses and protocol frames for their own owners.
          if (message.__wskit?.correlationId !== undefined) return message;
          if (message.event.startsWith('__')) return message;
          // A namespace-scoped stream chunk carries a streamId — it belongs to
          // the stream primitive, not namespace.on(). Pass it through untouched.
          if (message.__wskit?.streamId !== undefined) return message;

          dispatchToHandlers(handlers.get(name)?.get(message.event), helpers.log, message.payload);
          return message;
        },
        install(socket) {
          // @ts-expect-error — install adds namespace() to the socket dynamically
          socket.namespace = (name: string) => {
            const existing = cache.get(name);
            if (existing) return existing;

            function markers(): ScopeMarkers {
              return { namespace: name };
            }

            const messaging: MessagingObject = {
              on: (event: string, handler: Handler) => register(name, event, handler),
              send: (event: string, payload: unknown, callOptions?: { ttl?: number }) => {
                const ttl = callOptions?.ttl ?? resolveTtl(event);
                return helpers.send(
                  { event, payload, __wskit: markers() },
                  ttl !== undefined ? { ttl } : undefined,
                );
              },
            };

            applyAugmenters(socket, messaging, { markers });
            cache.set(name, messaging);

            return messaging;
          };
        },
      };
    },
  };
}
