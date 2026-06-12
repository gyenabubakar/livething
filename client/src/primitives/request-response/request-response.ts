import { Disconnected, Timeout } from '~/errors.ts';
import { toWSKitError } from '~/internal/error-frame.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import type { WireMessage } from '~/internal/runtime.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type {
  RequestResponseOptions,
  RequestResponseTypeFn,
} from '~/primitives/request-response/types.ts';
import type { Primitive } from '~/primitives/types.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Turns the usual one-way send into ask-and-wait: `socket.request(...)` sends a
 * message tagged with a unique id and returns a promise that resolves when the
 * server replies to that exact message. The promise rejects on timeout, on a
 * typed server error, or if you disconnect while waiting.
 */
export function requestResponse(
  options: RequestResponseOptions = {},
): Primitive<RequestResponseTypeFn> {
  const defaultTimeout = options.timeout ?? 10_000;

  return {
    _tag: 'requestResponse',
    setup(helpers) {
      const pending = new Map<string, Pending>();
      // Frames for requests made before the socket is open when no buffering is
      // installed to hold them. helpers.send drops while not open, so we keep them
      // here and flush on onOpen — otherwise a request made during the connect
      // window would be dropped and only fail by timing out.
      const outbox = new Map<string, WireMessage>();

      function sendRequest(
        event: string,
        payload: unknown,
        callOptions: { markers: ScopeMarkers; timeout?: number },
      ): Promise<unknown> {
        const correlationId = helpers.generateId('req');
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
          }, callOptions.timeout ?? defaultTimeout);

          pending.set(correlationId, {
            resolve: (value) => {
              clearTimeout(timer);
              done();
              resolve(value);
            },
            reject: (reason) => {
              clearTimeout(timer);
              done();
              reject(reason);
            },
          });

          const frame: WireMessage = {
            event,
            payload,
            __wskit: { correlationId, ...callOptions.markers },
          };
          // Send through the normal path so buffering can take it — queueing it
          // while offline, or behind a still-draining staggered flush so it can't
          // race ahead of not-yet-flushed messages. With no buffering, hold it only
          // while a connect is in progress (flushed on onOpen); on a closed socket
          // nothing will flush it, so fail fast instead of hanging to the timeout.
          const delivered = helpers.send(frame);
          if (!delivered) {
            const state = helpers.getState();
            if (state === 'connecting' || state === 'reconnecting') {
              outbox.set(correlationId, frame);
            } else {
              clearTimeout(timer);
              done();
              reject(Disconnected());
            }
          }
        });
      }

      return {
        id: 'requestResponse',
        onOpen() {
          if (outbox.size === 0) return null;
          const frames = [...outbox.values()];
          outbox.clear();
          return frames;
        },
        onIncoming(message) {
          const correlationId = message.__wskit?.correlationId;
          if (typeof correlationId !== 'string') return message;
          const waiter = pending.get(correlationId);
          // A reply with no pending waiter is a late/duplicate response to a request
          // that already settled (timed out, rejected on disconnect, or resolved by an
          // earlier reply). Drop it so it can't leak to on() handlers or onError.
          if (!waiter) return null;

          helpers.log.info(`matched response for request '${correlationId}'`);
          if (message.event === '__error__') waiter.reject(toWSKitError(message.payload));
          else waiter.resolve(message.payload);
          return null;
        },
        onClose() {
          for (const waiter of pending.values()) waiter.reject(Disconnected());
          pending.clear();
          outbox.clear();
        },
        install(socket) {
          // @ts-expect-error — install adds request() to the socket dynamically
          socket.request = (event: string, payload: unknown, callOptions?: { timeout?: number }) =>
            sendRequest(event, payload, { markers: {}, timeout: callOptions?.timeout });

          // Let channel messaging objects make scoped requests too.
          getAugmenters(socket).push((messaging, scope) => {
            messaging.request = (
              event: string,
              payload: unknown,
              callOptions?: { timeout?: number },
            ) => {
              scope.assertReady?.();
              return sendRequest(event, payload, {
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
