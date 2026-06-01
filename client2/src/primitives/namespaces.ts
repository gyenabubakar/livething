import { applyAugmenters } from '~/internal/scoped.ts';
import type { EndpointObject, ScopeMarkers } from '~/internal/scoped.ts';
import type { Primitive, TypeFn } from '~/primitives/types.ts';
import type { ScopeContract, ScopedApi } from '~/types.ts';

/** Adds `socket.namespace(name)` typed from the contract's `namespaces`. */
export interface NamespacesTypeFn extends TypeFn {
  readonly _api: ScopedApi<this['_contract'], 'namespaces', 'namespace'>;
}

/** Options for `namespaces()`. */
export interface NamespacesOptions {
  /** Buffer TTL for namespace events: one number for all, or a per-event map. */
  ttl?: number | Record<string, number>;
}

type Handler = (data: unknown) => void;

/**
 * Splits one connection into named groups of events. A namespace is just
 * routing — there's no server-side membership and nothing to subscribe to.
 * Calling `socket.namespace('chat')` hands you an endpoint whose `on`/`send`
 * are scoped to that name, tagged on the wire with `__wskit.namespace`.
 */
export function namespaces(
  options: NamespacesOptions = {},
): Primitive<NamespacesTypeFn, { namespaces: Record<string, ScopeContract> }> {
  return {
    _tag: 'namespaces',
    setup(helpers) {
      // namespace name -> event name -> handlers
      const handlers = new Map<string, Map<string, Set<Handler>>>();
      const endpoints = new Map<string, EndpointObject>();

      function resolveTtl(event: string): number | undefined {
        if (typeof options.ttl === 'number') return options.ttl;
        if (options.ttl) return options.ttl[event];
        return undefined;
      }

      function register(name: string, event: string, handler: Handler): () => void {
        let byEvent = handlers.get(name);
        if (!byEvent) handlers.set(name, (byEvent = new Map()));
        let set = byEvent.get(event);
        if (!set) byEvent.set(event, (set = new Set()));
        set.add(handler);
        helpers.lazyAcquire();
        return () => {
          set!.delete(handler);
          if (set!.size === 0) byEvent!.delete(event);
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

          const set = handlers.get(name)?.get(message.event);
          if (set) for (const handler of [...set]) handler(message.payload);
          return null;
        },
        install(socket) {
          // @ts-expect-error — install adds namespace() to the socket dynamically
          socket.namespace = (name: string) => {
            const existing = endpoints.get(name);
            if (existing) return existing;

            function markers(): ScopeMarkers {
              return { namespace: name };
            }

            const endpoint: EndpointObject = {
              on: (event: string, handler: Handler) => register(name, event, handler),
              send: (event: string, payload: unknown, opts?: { ttl?: number }) => {
                const ttl = opts?.ttl ?? resolveTtl(event);
                return helpers.send(
                  { event, payload, __wskit: markers() },
                  ttl !== undefined ? { ttl } : undefined,
                );
              },
            };

            applyAugmenters(socket, endpoint, { markers });
            endpoints.set(name, endpoint);

            return endpoint;
          };
        },
      };
    },
  };
}
