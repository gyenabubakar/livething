import { getAugmenters, scopedName } from '~/internal/scoped.ts';
import type { Message } from '~/internal/runtime.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type { ServerRequestsTypeFn } from '~/primitives/server-requests/types.ts';
import type { Primitive, PrimitiveIdentity } from '~/primitives/types.ts';

/** A registered handler that answers one server→client request event. */
type RequestHandler = (payload: unknown) => unknown | Promise<unknown>;

/**
 * The registry key for a handler: its scope (channel + family key, both `null`
 * for a top-level handler) plus the event name, JSON-encoded. Channel
 * `onRequest` handlers only answer frames carrying the same channel markers; a
 * top-level handler only answers frames with no channel marker. JSON keeps the
 * key unambiguous for any name without relying on a reserved separator.
 */
function handlerKey(markers: ScopeMarkers, event: string): string {
  return JSON.stringify([markers.name ?? null, markers.family ?? null, event]);
}

/**
 * The receiving half of two-way requests: lets the **server** ask this client a
 * question. Register a handler with `socket.onRequest(event, handler)`; when the
 * server sends a request frame (a normal event carrying an exchange id), the
 * handler runs and its return value is sent back to the server as the answer.
 *
 * This is the mirror of `clientRequests()` (client→server). The two are
 * order-independent: each claims only its own direction via metadata.exchange.source
 * (`clientRequests` ignores server-originated frames; `serverRequests` ignores
 * everything else), so a reply to the client's own request and a server-initiated
 * request never reach the wrong primitive regardless of registration order.
 */
export function serverRequests(): Primitive<ServerRequestsTypeFn> &
  PrimitiveIdentity<'serverRequests'> {
  return {
    _tag: 'serverRequests',

    setup(helpers) {
      // Keyed by handlerKey(scope, event): a channel `onRequest` answers only its
      // own channel's frames, a top-level one answers only unscoped frames.
      const handlers = new Map<string, RequestHandler>();

      function register(event: string, handler: RequestHandler, markers: ScopeMarkers): () => void {
        const key = handlerKey(markers, event);

        if (handlers.has(key)) {
          helpers.log.warn(`onRequest('${event}') replaced an existing handler`);
        }

        handlers.set(key, handler);

        return () => {
          if (handlers.get(key) === handler) handlers.delete(key);
        };
      }

      /** The channel markers to echo back on a reply, taken from the request frame. */
      function replyMarkers(message: Message): Message['metadata'] {
        const channel = message.metadata?.channel;
        return channel ? { channel: { ...channel } } : null;
      }

      function reply(correlationId: string, markers: Message['metadata'], frame: Message): void {
        // The server originated this request; tag the reply so the server routes
        // it back to its pending request rather than treating it as a new one.
        helpers.rawSend({
          ...frame,
          metadata: {
            exchange: { id: correlationId, source: 'server' },
            ...(markers ?? {}),
          },
        });
      }

      async function answer(message: Message, handler: RequestHandler): Promise<void> {
        const correlationId = message.metadata?.exchange?.id as string;
        const markers = replyMarkers(message);

        try {
          const result = await handler(message.payload);
          reply(correlationId, markers, { event: message.event, payload: result, metadata: null });
        } catch (error) {
          helpers.log.warn(`onRequest('${message.event}') handler threw`, error);
          reply(correlationId, markers, {
            event: '__error__',
            payload: { code: 'request-no-response' },
            metadata: null,
          });
        }
      }

      return {
        id: 'serverRequests',

        onIncoming(message) {
          const metadata = message.metadata;
          const correlationId = metadata?.exchange?.id;
          if (typeof correlationId !== 'string') return message;

          // Only a server-originated request is ours to answer. A reply to the
          // client's own request (source !== 'server') passes through for
          // clientRequests to claim — even when it shares an event name with an
          // onRequest handler, since source, not the name, decides direction.
          if (metadata?.exchange?.source !== 'server') return message;

          const frameMarkers: ScopeMarkers = metadata.channel
            ? {
                name: metadata.channel.name,
                ...(metadata.channel.family ? { family: metadata.channel.family } : {}),
              }
            : {};

          // Strict scope match: a channel-marked request reaches only that
          // channel's handler, and an unscoped one only a top-level handler.
          const handler = handlers.get(handlerKey(frameMarkers, message.event));
          if (!handler) {
            // A server request with no handler: fast-fail so its pending promise
            // rejects with `request-no-response` instead of hanging to timeout.
            reply(correlationId, replyMarkers(message), {
              event: '__error__',
              payload: { code: 'request-no-response' },
              metadata: null,
            });
            return null;
          }

          void answer(message, handler);

          return null;
        },

        install(socket) {
          // @ts-expect-error — install adds onRequest() to the socket dynamically
          socket.onRequest = (event: string, handler: RequestHandler) =>
            register(event, handler, {});

          getAugmenters(socket).push((messaging, scope) => {
            messaging.onRequest = (event: string, handler: RequestHandler) =>
              register(scopedName(scope, event), handler, scope.markers());
          });
        },
      };
    },
  };
}

serverRequests.tag = 'serverRequests' as const;
