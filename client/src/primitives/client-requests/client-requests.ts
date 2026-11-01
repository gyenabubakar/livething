import { Disconnected, Timeout } from '~/errors.ts';
import { timerDelayError } from '~/internal/config.ts';
import { toLiveThingError, unscopeErrorCode } from '~/internal/error-frame.ts';
import { idGenerator } from '~/internal/id.ts';
import { getAugmenters, scopedName } from '~/internal/scoped.ts';
import { isProtocolFrameEvent, wireIdError } from '~/internal/wire-validation.ts';
import type { FrameOwner, Message, SendResult } from '~/internal/runtime.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type {
  ClientRequestsOptions,
  ClientRequestsTypeFn,
} from '~/primitives/client-requests/types.ts';
import type { Primitive } from '~/primitives/types.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface RequestCallOptions {
  markers: ScopeMarkers;
  timeout?: number;
}

interface RequestOptions {
  timeout?: number;
}

/**
 * Turns the usual one-way send into ask-and-wait: `socket.request(...)` sends a
 * message tagged with a unique id and returns a promise that resolves when the
 * server replies to that exact message. The promise rejects on timeout, on a
 * typed server error, or if you disconnect while waiting.
 *
 * Call it while the socket is open or connecting. On a non-lazy socket that you
 * have not `connect()`ed yet (state `closed`), it rejects at once with
 * `disconnected` — a lazy socket connects on first use, and `buffering()` holds
 * sends made while offline.
 */
export function clientRequests(
  options: ClientRequestsOptions = {},
): Primitive<ClientRequestsTypeFn> {
  const defaultTimeout = options.timeout ?? 10_000;
  const defaultTimeoutError = timerDelayError(defaultTimeout, 'clientRequests timeout');
  if (defaultTimeoutError) throw defaultTimeoutError;

  return {
    _tag: 'clientRequests',
    setup(helpers) {
      const pending = new Map<string, Pending>();
      // frames for requests made before the socket is open when no buffering is
      // installed to hold them.
      const outbox = new Map<string, { message: Message; owner: FrameOwner }>();

      function ownerFor(correlationId: string): FrameOwner {
        return {
          isPending: () => pending.has(correlationId),
          reject: (error) => pending.get(correlationId)?.reject(error),
        };
      }

      function sendRequest(
        event: string,
        payload: unknown,
        callOptions: RequestCallOptions,
      ): Promise<unknown> {
        const eventError = wireIdError(event, event, 'event');
        if (eventError) return Promise.reject(eventError);

        const timeout = callOptions.timeout ?? defaultTimeout;
        const timeoutError = timerDelayError(timeout, 'request timeout');
        if (timeoutError) return Promise.reject(timeoutError);

        const correlationId = idGenerator(helpers)('req');

        helpers.lazyAcquire();
        helpers.ensureConnected();

        return new Promise((resolve, reject) => {
          function done(): void {
            pending.delete(correlationId);
            outbox.delete(correlationId);
            helpers.lazyRelease();
          }

          const timer = setTimeout(() => {
            done();
            reject(Timeout());
          }, timeout);

          pending.set(correlationId, {
            resolve: (value) => {
              clearTimeout(timer);
              done();
              resolve(value);
            },

            reject: (reason) => {
              clearTimeout(timer);
              done();
              // A plugin request's server error arrives namespaced (`__id::code`);
              // strip it back to the plain code the plugin declared. A plain app
              // event, a built-in code, or a Timeout/Disconnected passes through.
              reject(unscopeErrorCode(event, reason));
            },
          });

          const frame: Message = {
            event,
            payload,
            // The client originates this request, so its reply routes back here.
            metadata: {
              exchange: { id: correlationId, source: 'client' },
              ...(callOptions.markers.name
                ? {
                    channel: {
                      name: callOptions.markers.name,
                      ...(callOptions.markers.family ? { family: callOptions.markers.family } : {}),
                    },
                  }
                : {}),
            },
          };

          // send through the normal path so buffering can take it — queueing it
          // while offline, or behind a still-draining staggered flush so it can't
          // race ahead of not-yet-flushed messages. With no buffering, hold it only
          // while a connect is in progress (flushed on onOpen); on a closed socket
          // nothing will flush it, so fail fast instead of hanging to the timeout.
          const owner = ownerFor(correlationId);
          let result: SendResult;

          try {
            result = helpers.send(frame, { owner });
          } catch (error) {
            clearTimeout(timer);
            done();
            reject(error);
            return;
          }

          if (result === 'connecting') {
            outbox.set(correlationId, { message: frame, owner });
          } else if (result === 'closed' || result === 'blocked') {
            clearTimeout(timer);
            done();
            reject(Disconnected());
          }
        });
      }

      return {
        id: 'clientRequests',

        onOpen() {
          const entries = [...outbox.values()];
          outbox.clear();

          for (const { message, owner } of entries) {
            if (owner.isPending()) helpers.rawSend(message, owner);
          }

          return null;
        },

        onIncoming(message) {
          const correlationId = message.metadata?.exchange?.id;
          if (typeof correlationId !== 'string') return message;

          // A server-originated request is not a reply to our own request — let
          // the serverRequests primitive answer it, whatever order they run in. We
          // only ever claim a frame that matches one of our pending requests.
          if (message.metadata?.exchange?.source === 'server') return message;

          const waiter = pending.get(correlationId);
          // Forward a protocol frame (e.g. a receipt-query result) for another primitive
          // to claim; a stale `__error__` reply is ours to drop, as is any user reply.
          if (!waiter) {
            return isProtocolFrameEvent(message.event) && message.event !== '__error__'
              ? message
              : null;
          }

          if (helpers.log.debug) {
            helpers.log.info(`matched response for request '${correlationId}'`);
          }

          if (message.event === '__error__') waiter.reject(toLiveThingError(message.payload));
          else waiter.resolve(message.payload ?? undefined);

          return null;
        },

        onClose() {
          for (const waiter of pending.values()) waiter.reject(Disconnected());
          pending.clear();
          outbox.clear();
        },

        install(socket) {
          // @ts-expect-error — install adds request() to the socket dynamically
          socket.request = (event: string, payload: unknown, callOptions?: RequestOptions) =>
            sendRequest(event, payload, { markers: {}, timeout: callOptions?.timeout });

          getAugmenters(socket).push((messaging, scope) => {
            messaging.request = (event: string, payload: unknown, callOptions?: RequestOptions) => {
              scope.assertReady?.();
              return sendRequest(scopedName(scope, event), payload, {
                markers: scope.markers(),
                timeout: callOptions?.timeout,
              });
            };
          });
        },
      };
    },
  };
}

clientRequests.tag = 'clientRequests';
