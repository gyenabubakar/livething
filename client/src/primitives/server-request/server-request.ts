import { getAugmenters } from '~/internal/scoped.ts';
import type { WireMessage } from '~/internal/runtime.ts';
import type {
  ServerRequestOptions,
  ServerRequestTypeFn,
} from '~/primitives/server-request/types.ts';
import type { Primitive } from '~/primitives/types.ts';

/** A registered handler that answers one server→client request event. */
type RequestHandler = (payload: unknown) => unknown | Promise<unknown>;

/**
 * The receiving half of two-way requests: lets the **server** ask this client a
 * question. Register a handler with `socket.onRequest(event, handler)`; when the
 * server sends a request frame (a normal event carrying a `correlationId`), the
 * handler runs and its return value is sent back to the server as the answer.
 *
 * This is the mirror of `requestResponse()` (client→server). It must run after
 * `requestResponse` and `ack` so a reply to the client's *own* request is
 * consumed by those first — only a server-initiated request reaches here.
 */
export function serverRequest(_options: ServerRequestOptions = {}): Primitive<ServerRequestTypeFn> {
  return {
    _tag: 'serverRequest',
    // Runs BEFORE requestResponse/ack (they declare `optionalAfter:
    // ['serverRequest']`). Those swallow any correlated frame with no pending
    // waiter, so serverRequest must see a server-initiated request first. It
    // only consumes frames whose event has a registered handler; a reply to the
    // client's own request (a different event name) passes straight through.
    setup(helpers) {
      const handlers = new Map<string, RequestHandler>();

      function register(event: string, handler: RequestHandler): () => void {
        if (handlers.has(event)) {
          helpers.log.warn(`onRequest('${event}') replaced an existing handler`);
        }
        handlers.set(event, handler);
        return () => {
          if (handlers.get(event) === handler) handlers.delete(event);
        };
      }

      function reply(
        correlationId: string,
        markers: WireMessage['__wskit'],
        frame: WireMessage,
      ): void {
        helpers.rawSend({ ...frame, __wskit: { correlationId, ...markers } });
      }

      async function answer(message: WireMessage, handler: RequestHandler): Promise<void> {
        const correlationId = message.__wskit?.correlationId as string;
        const markers: WireMessage['__wskit'] = {};
        if (message.__wskit?.channel !== undefined) markers.channel = message.__wskit.channel;
        if (message.__wskit?.channelScope !== undefined) {
          markers.channelScope = message.__wskit.channelScope;
        }
        try {
          const result = await handler(message.payload);
          reply(correlationId, markers, { event: message.event, payload: result });
        } catch (error) {
          // The handler threw — tell the server so its pending promise rejects
          // fast instead of waiting out its timeout.
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
          const correlationId = message.__wskit?.correlationId;
          if (typeof correlationId !== 'string') return message;

          const handler = handlers.get(message.event);
          // A correlated frame with no registered handler is not ours — pass it
          // through (it may be a reply requestResponse/ack already settled, or a
          // plain event the app handles).
          if (!handler) return message;

          void answer(message, handler);
          return null;
        },

        install(socket) {
          // @ts-expect-error — install adds onRequest() to the socket dynamically
          socket.onRequest = (event: string, handler: RequestHandler) => register(event, handler);

          getAugmenters(socket).push((messaging) => {
            messaging.onRequest = (event: string, handler: RequestHandler) =>
              register(event, handler);
          });
        },
      };
    },
  };
}

serverRequest.tag = 'serverRequest';
