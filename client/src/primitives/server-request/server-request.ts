import { getAugmenters, scopedName } from '~/internal/scoped.ts';
import type { WireMessage } from '~/internal/runtime.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type {
  ServerRequestOptions,
  ServerRequestTypeFn,
} from '~/primitives/server-request/types.ts';
import type { Primitive } from '~/primitives/types.ts';

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
  return JSON.stringify([markers.channel ?? null, markers.channelFamily ?? null, event]);
}

/**
 * The receiving half of two-way requests: lets the **server** ask this client a
 * question. Register a handler with `socket.onRequest(event, handler)`; when the
 * server sends a request frame (a normal event carrying a `correlationId`), the
 * handler runs and its return value is sent back to the server as the answer.
 *
 * This is the mirror of `requestResponse()` (client→server). The two are
 * order-independent: each claims only its own direction via `__wskit.source`
 * (`requestResponse` ignores `source: 'server'` frames; `serverRequest` ignores
 * everything else), so a reply to the client's own request and a server-initiated
 * request never reach the wrong primitive regardless of registration order.
 */
export function serverRequest(_options: ServerRequestOptions = {}): Primitive<ServerRequestTypeFn> {
  return {
    _tag: 'serverRequest',

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
      function replyMarkers(message: WireMessage): WireMessage['__wskit'] {
        const markers: WireMessage['__wskit'] = {};
        if (message.__wskit?.channel !== undefined) markers.channel = message.__wskit.channel;
        if (message.__wskit?.channelFamily !== undefined) {
          markers.channelFamily = message.__wskit.channelFamily;
        }
        return markers;
      }

      function reply(
        correlationId: string,
        markers: WireMessage['__wskit'],
        frame: WireMessage,
      ): void {
        // The server originated this request; tag the reply so the server routes
        // it back to its pending request rather than treating it as a new one.
        helpers.rawSend({ ...frame, __wskit: { correlationId, source: 'server', ...markers } });
      }

      async function answer(message: WireMessage, handler: RequestHandler): Promise<void> {
        const correlationId = message.__wskit?.correlationId as string;
        const markers = replyMarkers(message);

        try {
          const result = await handler(message.payload);
          reply(correlationId, markers, { event: message.event, payload: result });
        } catch (error) {
          helpers.log.warn(`onRequest('${message.event}') handler threw`, error);
          reply(correlationId, markers, {
            event: '__error__',
            payload: { code: 'request-no-response' },
          });
        }
      }

      return {
        id: 'serverRequest',

        onIncoming(message) {
          const wskit = message.__wskit;
          const correlationId = wskit?.correlationId;
          if (typeof correlationId !== 'string') return message;

          // Only a server-originated request is ours to answer. A reply to the
          // client's own request (source !== 'server') passes through for
          // requestResponse to claim — even when it shares an event name with an
          // onRequest handler, since source, not the name, decides direction.
          if (wskit?.source !== 'server') return message;

          const frameMarkers: ScopeMarkers = {};
          if (wskit.channel !== undefined) frameMarkers.channel = wskit.channel;
          if (wskit.channelFamily !== undefined && wskit.channelFamily !== null) {
            frameMarkers.channelFamily = wskit.channelFamily;
          }

          // Strict scope match: a channel-marked request reaches only that
          // channel's handler, and an unscoped one only a top-level handler.
          const handler = handlers.get(handlerKey(frameMarkers, message.event));
          if (!handler) {
            // A server request with no handler: fast-fail so its pending promise
            // rejects with `request-no-response` instead of hanging to timeout.
            reply(correlationId, replyMarkers(message), {
              event: '__error__',
              payload: { code: 'request-no-response' },
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

serverRequest.tag = 'serverRequest';
